const express = require('express');
const { initializeApp, cert } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore } = require('firebase-admin/firestore');
const axios = require('axios');
const cors = require('cors');

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

initializeApp({
  credential: cert(serviceAccount)
});

const db = getFirestore();
const app = express();

app.use(cors());
app.use(express.json());

const MERCADO_PAGO_TOKEN = process.env.MERCADO_PAGO_TOKEN;
const ADMIN_EMAILS = ['celsogiodias@gmail.com'];

// ─── Verificar se usuário tem early access ───
app.post('/verificarAcesso', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Usuário não autenticado.' });
    }

    const idToken = authHeader.split('Bearer ')[1];
    const decodedToken = await getAuth().verifyIdToken(idToken);
    const email = decodedToken.email;

    // Verifica se o email está na lista de early access
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

// ─── Admin: adicionar email na lista de early access ───
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

// ─── Admin: listar early access ───
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

// ─── Criar pagamento (já existente) ───
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

// ─── Admin: listar assinantes ───
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
    const assinantes = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

    return res.json({ assinantes });
  } catch (error) {
    console.error('Erro:', error.message);
    return res.status(500).json({ error: 'Erro ao listar assinantes.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
