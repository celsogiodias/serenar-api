const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const { MercadoPagoConfig, Preference } = require('mercadopago');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());

// ─── FIREBASE ADMIN ─────────────────────────────────
const serviceAccount = {
  type: 'service_account',
  project_id: 'serenus-app',
  private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
  private_key: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  client_email: process.env.FIREBASE_CLIENT_EMAIL,
  client_id: process.env.FIREBASE_CLIENT_ID,
  auth_uri: 'https://accounts.google.com/o/oauth2/auth',
  token_uri: 'https://oauth2.googleapis.com/token',
  auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
  client_x509_cert_url: process.env.FIREBASE_CERT_URL,
};

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// ─── MERCADO PAGO ───────────────────────────────────
const client = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN });

// ─── MIDDLEWARE ─────────────────────────────────────
async function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token ausente' });
  }
  try {
    const decodedToken = await admin.auth().verifyIdToken(header.split(' ')[1]);
    req.user = decodedToken;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Token inválido' });
  }
}

// ─── HEALTH CHECK ───────────────────────────────────
app.get('/', (req, res) => res.send('API Serenar rodando!'));

// ─── SESSÃO ÚNICA ──────────────────────────────────
app.post('/iniciarSessao', authMiddleware, async (req, res) => {
  try {
    const { deviceId } = req.body;
    const userId = req.user.uid;
    const sessionToken = crypto.randomUUID();
    await db.collection('sessoes').doc(userId).set({
      sessionToken,
      deviceId,
      ultimoLogin: admin.firestore.FieldValue.serverTimestamp(),
    });
    res.json({ sessionToken });
  } catch (error) {
    console.error('Erro ao iniciar sessão:', error);
    res.status(500).json({ error: 'Erro ao iniciar sessão' });
  }
});

app.post('/validarSessao', authMiddleware, async (req, res) => {
  try {
    const { sessionToken } = req.body;
    const userId = req.user.uid;
    const doc = await db.collection('sessoes').doc(userId).get();
    if (!doc.exists) {
      return res.json({ valida: true, motivo: null });
    }
    const sessao = doc.data();
    const valida = sessao.sessionToken === sessionToken;
    res.json({
      valida,
      motivo: valida ? null : 'Sessão expirada — outro dispositivo fez login',
    });
  } catch (error) {
    console.error('Erro ao validar sessão:', error);
    res.status(500).json({ error: 'Erro ao validar sessão' });
  }
});

// ─── PAGAMENTO ─────────────────────────────────────
app.post('/criarPagamento', authMiddleware, async (req, res) => {
  try {
    const { plano } = req.body;
    const userId = req.user.uid;

    const precos = { mensal: 9.90, lancamento: 89.90 };
    const titulos = { mensal: 'Serenar - Plano Mensal', lancamento: 'Serenar - Plano Lançamento' };

    const preco = precos[plano];
    const titulo = titulos[plano];

    if (!preco) return res.status(400).json({ error: 'Plano inválido' });

    const preference = new Preference(client);
    const result = await preference.create({
      body: {
        items: [{
          id: `plano_${plano}_${userId}`,
          title: titulo,
          quantity: 1,
          currency_id: 'BRL',
          unit_price: preco,
        }],
        payer: { email: req.user.email },
        back_urls: {
          success: 'serenarapp://pagamento/sucesso',
          failure: 'serenarapp://pagamento/erro',
          pending: 'serenarapp://pagamento/pendente',
        },
        auto_return: 'approved',
        notification_url: 'https://serenar-api.onrender.com/webhook',
        metadata: { userId, plano },
      },
    });

    res.json({ url: result.init_point });
  } catch (error) {
    console.error('Erro ao criar pagamento:', error);
    res.status(500).json({ error: 'Erro ao gerar pagamento' });
  }
});

// ─── WEBHOOK ───────────────────────────────────────
app.post('/webhook', async (req, res) => {
  try {
    const { type, data } = req.body;
    console.log('Webhook recebido:', type);

    if (type === 'payment') {
      const paymentId = data.id;

      const response = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
        headers: { Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}` },
      });
      const payment = await response.json();

      if (payment.status === 'approved') {
        const { userId, plano } = payment.metadata;
        await db.collection('usuarios').doc(userId).update({
          acessoPago: true,
          plano,
          dataAtivacao: admin.firestore.FieldValue.serverTimestamp(),
          paymentId,
        });
        console.log(`Usuário ${userId} ativado (${plano})`);
      }
    }

    res.sendStatus(200);
  } catch (error) {
    console.error('Erro no webhook:', error);
    res.sendStatus(200);
  }
});

// ─── ESTORNO ───────────────────────────────────────
app.post('/estornarPagamento', authMiddleware, async (req, res) => {
  try {
    const { paymentId } = req.body;
    const userId = req.user.uid;

    const response = await fetch(
      `https://api.mercadopago.com/v1/payments/${paymentId}/refunds`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.MP_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const data = await response.json();

    if (data.status === 'approved' || data.status === 'refunded') {
      await db.collection('usuarios').doc(userId).update({
        acessoPago: false,
        dataEstorno: admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    res.json(data);
  } catch (error) {
    console.error('Erro ao estornar:', error);
    res.status(500).json({ error: 'Erro ao estornar pagamento' });
  }
});

// 
// ─── NOVAS ROTAS: EARLY ACCESS E ASSINANTES ───────
// 

// ─── LISTAR EARLY ACCESS ──────────────────────────
app.get('/listarEarlyAccess', authMiddleware, async (req, res) => {
  try {
    const snapshot = await db.collection('early_access').get();
    const emails = [];

    snapshot.forEach(doc => {
      const data = doc.data();
      emails.push({
        email: doc.id,
        status: data.status || 'convidado',
        criadoEm: data.criadoEm?.toDate()?.toISOString() || null,
      });
    });

    res.json({ emails });
  } catch (error) {
    console.error('Erro ao listar early access:', error);
    res.status(500).json({ error: 'Erro ao listar early access' });
  }
});

// ─── ADICIONAR EARLY ACCESS ──────────────────────
app.post('/adicionarEarlyAccess', authMiddleware, async (req, res) => {
  try {
    const { email } = req.body;

    if (!email || !email.includes('@')) {
      return res.status(400).json({ error: 'Email inválido' });
    }

    const emailLimpo = email.trim().toLowerCase();

    // Verifica se já existe
    const doc = await db.collection('early_access').doc(emailLimpo).get();
    if (doc.exists) {
      return res.json({ sucesso: true, mensagem: 'Email já está na lista' });
    }

    await db.collection('early_access').doc(emailLimpo).set({
      email: emailLimpo,
      status: 'convidado',
      criadoEm: admin.firestore.FieldValue.serverTimestamp(),
      adicionadoPor: req.user.uid,
    });

    console.log(`Early access adicionado: ${emailLimpo}`);
    res.json({ sucesso: true });
  } catch (error) {
    console.error('Erro ao adicionar early access:', error);
    res.status(500).json({ error: 'Erro ao adicionar early access' });
  }
});

// ─── LISTAR ASSINANTES ───────────────────────────
app.get('/listarAssinantes', authMiddleware, async (req, res) => {
  try {
    const snapshot = await db.collection('usuarios')
      .where('acessoPago', '==', true)
      .get();

    const assinantes = [];

    snapshot.forEach(doc => {
      const data = doc.data();
      assinantes.push({
        uid: doc.id,
        email: data.email || 'desconhecido',
        plano: data.plano || 'mensal',
        status: data.acessoPago ? 'ativo' : 'inativo',
        dataAtivacao: data.dataAtivacao?.toDate()?.toISOString() || data.dataAtivacao || null,
      });
    });

    res.json({ assinantes });
  } catch (error) {
    console.error('Erro ao listar assinantes:', error);
    res.status(500).json({ error: 'Erro ao listar assinantes' });
  }
});

// ─── VERIFICAR ACESSO ────────────────────────────
app.post('/verificarAcesso', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.uid;
    const doc = await db.collection('usuarios').doc(userId).get();

    if (doc.exists && doc.data().acessoPago === true) {
      const data = doc.data();
      const DIAS_PLANO = { mensal: 30, semestral: 180, anual: 365 };
      const totalDias = DIAS_PLANO[data.plano] || 30;
      let diasRestantes = totalDias;

      if (data.dataAtivacao) {
        const ativacao = data.dataAtivacao.toDate ? data.dataAtivacao.toDate() : new Date(data.dataAtivacao);
        const agora = new Date();
        const diffMs = agora.getTime() - ativacao.getTime();
        const diffDias = Math.floor(diffMs / (1000 * 60 * 60 * 24));
        diasRestantes = Math.max(totalDias - diffDias, 0);
      }

      return res.json({
        acessoPago: true,
        plano: data.plano || 'mensal',
        diasRestantes,
      });
    }

    res.json({ acessoPago: false });
  } catch (error) {
    console.error('Erro ao verificar acesso:', error);
    res.status(500).json({ error: 'Erro ao verificar acesso' });
  }
});

// ─── INICIAR SERVIDOR ─────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
