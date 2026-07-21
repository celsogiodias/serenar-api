const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const { MercadoPagoConfig, Preference } = require('mercadopago');

const app = express();
app.use(cors());
app.use(express.json());

// Firebase Admin
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

// Mercado Pago
const mercadopago = new MercadoPago(process.env.MP_ACCESS_TOKEN, {
  sandbox: true
});

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

app.post('/criarPagamento', authMiddleware, async (req, res) => {
  try {
    const { plano } = req.body;
    const userId = req.user.uid;

    const precos = { mensal: 9.90, lancamento: 89.90 };
    const titulos = { mensal: 'Serenar - Plano Mensal', lancamento: 'Serenar - Plano Lançamento' };
    const preco = precos[plano];
    const titulo = titulos[plano];

    if (!preco) return res.status(400).json({ error: 'Plano inválido' });

    const preference = new Preference(mercadopago);
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
          success: 'https://serenar-app.web.app/pagamento/sucesso',
          failure: 'https://serenar-app.web.app/pagamento/erro',
          pending: 'https://serenar-app.web.app/pagamento/pendente',
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

app.post('/webhook', async (req, res) => {
  try {
    console.log('Webhook recebido:', JSON.stringify(req.body, null, 2));
    res.sendStatus(200);
  } catch (error) {
    console.error('Erro no webhook:', error);
    res.sendStatus(200);
  }
});

app.get('/', (req, res) => res.send('API Serenar rodando!'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server rodando na porta ${PORT}`));
