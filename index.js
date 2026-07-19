const functions = require('firebase-functions');
const admin = require('firebase-admin');
const axios = require('axios');

admin.initializeApp();

const MERCADO_PAGO_TOKEN = process.env.MERCADO_PAGO_TOKEN;

exports.criarPagamento = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError('unauthenticated', 'Usuário não autenticado.');
  }

  const { plano } = data;
  const uid = context.auth.uid;

  const precos = {
    mensal: { valor: 9.90, descricao: 'Serenar - Plano Mensal' },
    anual: { valor: 89.90, descricao: 'Serenar - Plano Anual' },
  };

  if (!precos[plano]) {
    throw new functions.https.HttpsError('invalid-argument', 'Plano inválido.');
  }

  try {
    const response = await axios.post(
      'https://api.mercadopago.com/checkout/preferences',
      {
        items: [{
          title: precos[plano].descricao,
          quantity: 1,
          currency_id: 'BRL',
          unit_price: precos[plano].valor,
        }],
        payer: { email: context.auth.token.email },
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

    return { url: response.data.init_point, preferenceId: response.data.id };
  } catch (error) {
    console.error('Erro Mercado Pago:', error.response?.data || error.message);
    throw new functions.https.HttpsError('internal', 'Erro ao gerar link de pagamento.');
  }
});
