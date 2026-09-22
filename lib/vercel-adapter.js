// lib/vercel-adapter.js
//
// Adatta un handler scritto in stile Netlify/AWS Lambda — async (event) => ({statusCode,
// headers, body}) — alla firma (req, res) richiesta dalle Vercel Serverless Functions.
// Permette di riusare la logica delle function porting da Netlify senza riscriverla: ogni
// file in /api esporta una funzione handleEvent(event) identica a prima, e questo adapter
// la traduce in un vero handler Vercel.

function toVercelHandler(handleEvent) {
  return async function (req, res) {
    const event = { queryStringParameters: req.query || {}, httpMethod: req.method };
    const result = await handleEvent(event);
    res.status(result.statusCode || 200);
    if (result.headers) {
      Object.entries(result.headers).forEach(([k, v]) => { if (v != null) res.setHeader(k, v); });
    }
    res.send(result.body != null ? result.body : '');
  };
}

module.exports = { toVercelHandler };
