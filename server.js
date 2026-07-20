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

    // Salvar subscription no Firestore
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
