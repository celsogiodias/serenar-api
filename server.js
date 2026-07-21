const express = require('express');
const { initializeApp, cert } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore } = require('firebase-admin/firestore');
const axios = require('axios');
const cors = require('cors');
const { Resend } = require('resend');

let serviceAccount;
if (process.env.SERVICE_ACCOUNT_JSON) {
  try {
    serviceAccount = JSON.parse(process.env.SERVICE_ACCOUNT_JSON);
  } catch (e) {
    console.error('Erro ao fazer parse do SERVICE_ACCOUNT_JSON');
    process.exit(1);
  }
} else {
  serviceAccount = require('./serviceAccountKey.json');
}

initializeApp({ credential: cert(serviceAccount) });

const db = getFirestore();
const app = express();

// Webhook precisa de body CRU (raw) para verificar assinatura
app.use('/api/webhook', express.raw({ type: '*/*' }));
app.use(cors());
app.use(express.json());

const MERCADO_PAGO_TOKEN = process.env.MERCADO_PAGO_TOKEN;
const ADMIN_EMAILS = ['celsogiodias@gmail.com'];
const resend = new Resend(process.env.RESEND_API_KEY);

// ─── Funções de Email ───

const enviarEmailBoasVindas = async (email, nome) => {
  try {
    await resend.emails.send({
      from: 'Serenar <onboarding@resend.dev>',
      to: email,
      subject: 'Bem-vindo ao Serenar! 🌙',
      html: `
        <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #2E86AB;">Bem-vindo ao Serenar, ${nome || 'usuário'}!</h2>
          <p>Que bom ter você conosco! Sua assinatura foi ativada com sucesso.</p>
          <p>Você agora tem acesso completo a todas as ferramentas de apoio emocional e regulação.</p>
          <p>Qualquer dúvida, estamos aqui para ajudar.</p>
          <br/>
          <p>Com carinho,<br/>Equipe Serenar</p>
        </div>
      `,
    });
    console.log(`Email de boas-vindas enviado para ${email}`);
  } catch (e) {
    console.error('Erro ao enviar email de boas-vindas:', e.message);
  }
};

const enviarEmailCancelamento = async (email, nome) => {
  try {
    await resend.emails.send({
      from: 'Serenar <onboarding@resend.dev>',
      to: email,
      subject: 'Assinatura Serenar cancelada',
      html: `
        <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #e74c3c;">Sentiremos sua falta</h2>
          <p>Olá ${nome || 'usuário'},</p>
          <p>Sua assinatura do Serenar foi cancelada.</p>
          <p>Seu acesso continua até o final do período já pago.</p>
          <p>Se mudar de ideia, você sempre pode reativar sua assinatura pelo app.</p>
          <br/>
          <p>Cuide-se,<br/>Equipe Serenar</p>
        </div>
      `,
    });
    console.log(`Email de cancelamento enviado para ${email}`);
  } catch (e) {
    console.error('Erro ao enviar email de cancelamento:', e.message);
  }
};

const enviarEmailRenovacao = async (email, nome) => {
  try {
    await resend.emails.send({
      from: 'Serenar <onboarding@resend.dev>',
      to: email,
      subject: 'Sua assinatura Serenar foi renovada',
      html: `
        <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #2E86AB;">Assinatura renovada! ✅</h2>
          <p>Olá ${nome || 'usuário'},</p>
          <p>Sua assinatura do Serenar foi renovada com sucesso.</p>
          <p>Continue cuidando da sua saúde emocional com a gente.</p>
          <br/>
          <p>Com carinho,<br/>Equipe Serenar</p>
        </div>
      `,
    });
    console.log(`Email de renovação enviado para ${email}`);
  } catch (e) {
    console.error('Erro ao enviar email de renovação:', e.message);
  }
};

// ─── Webhook Mercado Pago ───
app.post('/api/webhook/mercadopago', async (req, res) => {
  try {
    const event = JSON.parse(req.body);

    // Webhook de pagamento aprovado
    if (event.type === 'payment') {
      const paymentId = event.data.id;

      const paymentResponse = await axios.get(
        `https://api.mercadopago.com/v1/payments/${paymentId}`,
        { headers: { Authorization: `Bearer ${MERCADO_PAGO_TOKEN}` } }
      );

      const payment = paymentResponse.data;

      if (payment.status === 'approved') {
        // external_reference = uid_plano
        const [uid, plano] = (payment.external_reference || '_').split('_');
        const email = payment.payer.email;

        // Atualiza subscription no Firestore
        await db.collection('subscriptions').doc(uid).update({
          status: 'ativo',
          paymentId: paymentId,
          atualizadoEm: new Date().toISOString(),
        });

        // Busca nome do usuário
        const userDoc = await db.collection('usuarios').doc(uid).get();
        const nome = userDoc.exists ? userDoc.data().nome : '';

        await enviarEmailBoasVindas(email, nome);
      }
    }

    res.status(200).send('OK');
  } catch (error) {
    console.error('Erro no webhook:', error.message);
    res.status(200).send('OK'); // Sempre 200 para MP não reenviar
  }
});

// ─── Verificar early access ───
app.post('/verificarAcesso', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Usuário não autenticado.' });
    }
    const idToken = authHeader.split('Bearer ')[1];
    const decodedToken = await getAuth().verifyIdToken(idToken);
    const email = decodedToken.email;

    const doc = await db.collection('earlyAccess').doc(email).get();
    if (doc.exists && doc.data().status === 'convidado') {
      return res.json({ acesso: 'gratuito', mensagem: 'Acesso liberado via early access.' });
    }

    return res.json({ acesso: 'pago', mensagem: 'Usuário não está na lista de early access.' });
  } catch (error) {
    console.error('Erro:', error.message);
    return res.status(500).json({ error: 'Erro ao verificar acesso.' });
  }
});

// ─── Adicionar early access ───
app.post('/adicionarEarlyAccess', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Não autenticado.' });
    }
    const idToken = authHeader.split('Bearer ')[1];
    const decodedToken = await getAuth().verifyIdToken(idToken);

    if (!ADMIN_EMAILS.includes(decodedToken.email)) {
      return res.status(403).json({ error: 'Apenas o administrador pode adicionar emails.' });
    }

    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ error: 'Email é obrigatório.' });
    }

    await db.collection('earlyAccess').doc(email).set({
      email,
      status: 'convidado',
      criadoEm: new Date().toISOString(),
      adicionadoPor: decodedToken.email,
    });

    return res.json({ sucesso: true, mensagem: `${email} adicionado ao early access.` });
  } catch (error) {
    console.error('Erro:', error.message);
    return res.status(500).json({ error: 'Erro ao adicionar email.' });
  }
});

// ─── Listar early access ───
app.get('/listarEarlyAccess', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Não autenticado.' });
    }
    const idToken = authHeader.split('Bearer ')[1];
    const decodedToken = await getAuth().verifyIdToken(idToken);

    if (!ADMIN_EMAILS.includes(decodedToken.email)) {
      return res.status(403).json({ error: 'Apenas o administrador.' });
    }

    const snapshot = await db.collection('earlyAccess').get();
    const lista = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    return res.json({ emails: lista });
  } catch (error) {
    console.error('Erro:', error.message);
    return res.status(500).json({ error: 'Erro ao listar.' });
  }
});

// ─── Criar pagamento ───
app.post('/criarPagamento', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Usuário não autenticado.' });
    }
    const idToken = authHeader.split('Bearer ')[1];
    const decodedToken = await getAuth().verifyIdToken(idToken);
    const uid = decodedToken.uid;
    const email = decodedToken.email;

    const { plano } = req.body;
    const precos = {
      mensal: { valor: 9.90, descricao: 'Serenar - Plano Mensal' },
      anual: { valor: 89.90, descricao: 'Serenar - Plano Anual' },
    };

    if (!precos[plano]) {
      return res.status(400).json({ error: 'Plano inválido.' });
    }

    const response = await axios.post(
      'https://api.mercadopago.com/checkout/preferences',
      {
        items: [{
          title: precos[plano].descricao,
          quantity: 1,
          currency_id: 'BRL',
          unit_price: precos[plano].valor,
        }],
        payer: { email: email },
        back_urls: {
          success: 'serenarapp://pagamento/sucesso',
          failure: 'serenarapp://pagamento/erro',
          pending: 'serenarapp://pagamento/pendente',
        },
        auto_return: 'approved',
        external_reference: `${uid}_${plano}`,
        notification_url: 'https://serenar-api.onrender.com/api/webhook/mercadopago',
      },
      {
        headers: {
          Authorization: `Bearer ${MERCADO_PAGO_TOKEN}`,
          'Content-Type': 'application/json',
        },
      }
    );

    await db.collection('subscriptions').doc(uid).set({
      uid,
      email,
      plano,
      status: 'pendente',
      criadoEm: new Date().toISOString(),
    });

    return res.json({ url: response.data.init_point, preferenceId: response.data.id });
  } catch (error) {
    console.error('Erro:', error.response?.data || error.message);
    return res.status(500).json({ error: 'Erro ao gerar link de pagamento.' });
  }
});

// ─── Listar assinantes ───
app.get('/listarAssinantes', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Não autenticado.' });
    }
    const idToken = authHeader.split('Bearer ')[1];
    const decodedToken = await getAuth().verifyIdToken(idToken);

    if (!ADMIN_EMAILS.includes(decodedToken.email)) {
      return res.status(403).json({ error: 'Apenas o administrador.' });
    }

    const snapshot = await db.collection('subscriptions').get();
    const assinantes = snapshot.docs
      .map(doc => ({ id: doc.id, ...doc.data() }))
      .filter(a => !ADMIN_EMAILS.includes(a.email));

    return res.json({ assinantes });
  } catch (error) {
    console.error('Erro:', error.message);
    return res.status(500).json({ error: 'Erro ao listar assinantes.' });
  }
});

// ─── Teste: enviar email manual ───
app.post('/api/testarEmail', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Não autenticado.' });
    }
    const idToken = authHeader.split('Bearer ')[1];
    const decodedToken = await getAuth().verifyIdToken(idToken);
    const email = decodedToken.email;

    const { tipo } = req.body; // 'boasvindas', 'cancelamento' ou 'renovacao'

    const userDoc = await db.collection('usuarios').doc(decodedToken.uid).get();
    const nome = userDoc.exists ? userDoc.data().nome : '';

    if (tipo === 'boasvindas') {
      await enviarEmailBoasVindas(email, nome);
    } else if (tipo === 'cancelamento') {
      await enviarEmailCancelamento(email, nome);
    } else if (tipo === 'renovacao') {
      await enviarEmailRenovacao(email, nome);
    } else {
      return res.status(400).json({ error: 'Tipo inválido. Use: boasvindas, cancelamento ou renovacao' });
    }

    return res.json({ sucesso: true, mensagem: `Email de ${tipo} enviado para ${email}` });
  } catch (error) {
    console.error('Erro:', error.message);
    return res.status(500).json({ error: 'Erro ao enviar email.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
