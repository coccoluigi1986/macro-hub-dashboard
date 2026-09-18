// netlify/functions/fred-data.js
//
// Funzione serverless Netlify: recupera dati macro USA REALI e ufficiali
// dalla Federal Reserve Economic Data (FRED) — gratuita, nessun costo.
//
// SETUP RICHIESTO:
// 1. Registrati gratis su https://fred.stlouisfed.org/docs/api/api_key.html
// 2. Su Netlify: Site settings → Environment variables → aggiungi FRED_API_KEY con la tua chiave
// 3. Questa funzione sarà raggiungibile su: https://tuosito.netlify.app/.netlify/functions/fred-data

const SERIES = {
  cpi_yoy:        'CPIAUCSL',   // CPI headline (indice, va trasformato in % YoY)
  core_cpi_yoy:   'CPILFESL',   // Core CPI (indice)
  unemployment:   'UNRATE',     // Tasso di disoccupazione (%)
  nfp:            'PAYEMS',     // Occupati non agricoli (migliaia, va calcolata la variazione mensile)
  fed_funds:      'DFF',        // Tasso Fed Funds effettivo giornaliero
  gdp:            'GDPC1',      // PIL REALE trimestrale (chained dollars) — NON usare 'GDP' (nominale, include inflazione)
  ppi_yoy:        'PPIFIS',     // Producer Price Index — Final Demand (la serie "PPI" standard citata dai media/trader)
};

async function fetchSeries(seriesId, apiKey) {
  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}&api_key=${apiKey}&file_type=json&sort_order=desc&limit=14`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`FRED error for ${seriesId}: ${res.status}`);
  const data = await res.json();
  return data.observations || [];
}

// Calcola variazione % anno-su-anno da una serie mensile (indice)
function yoyChange(observations) {
  if (observations.length < 13) return null;
  const latest = parseFloat(observations[0].value);
  const yearAgo = parseFloat(observations[12].value);
  if (isNaN(latest) || isNaN(yearAgo)) return null;
  return (((latest - yearAgo) / yearAgo) * 100).toFixed(1);
}

// Calcola la crescita PIL trimestrale annualizzata (convenzione BEA) da due trimestri consecutivi.
// Usa la serie GDPC1 (PIL reale, chained dollars) — coerente con il modo in cui media e consensus
// di mercato riportano sempre la crescita del PIL. Non usare mai la serie 'GDP' (nominale): include
// l'inflazione e darebbe numeri molto più alti e non comparabili con le attese di consensus.
function gdpAnnualizedQoQ(observations) {
  if (observations.length < 2) return null;
  const latest = parseFloat(observations[0].value);
  const prev = parseFloat(observations[1].value);
  if (isNaN(latest) || isNaN(prev) || prev === 0) return null;
  const rate = (Math.pow(latest / prev, 4) - 1) * 100;
  return rate.toFixed(1);
}

// Calcola variazione mensile assoluta (per NFP, es. +23K)
function monthlyDelta(observations) {
  if (observations.length < 2) return null;
  const latest = parseFloat(observations[0].value);
  const prev = parseFloat(observations[1].value);
  if (isNaN(latest) || isNaN(prev)) return null;
  return Math.round(latest - prev); // in migliaia per PAYEMS
}

exports.handler = async function (event, context) {
  const apiKey = process.env.FRED_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'FRED_API_KEY non configurata nelle Environment Variables di Netlify' }),
    };
  }

  try {
    const [cpi, coreCpi, unemployment, nfp, fedFunds, gdp, ppi] = await Promise.all([
      fetchSeries(SERIES.cpi_yoy, apiKey),
      fetchSeries(SERIES.core_cpi_yoy, apiKey),
      fetchSeries(SERIES.unemployment, apiKey),
      fetchSeries(SERIES.nfp, apiKey),
      fetchSeries(SERIES.fed_funds, apiKey),
      fetchSeries(SERIES.gdp, apiKey),
      fetchSeries(SERIES.ppi_yoy, apiKey),
    ]);

    const result = {
      updatedAt: new Date().toISOString(),
      source: 'FRED (Federal Reserve Bank of St. Louis) — dati ufficiali pubblici',
      data: {
        cpiYoY: yoyChange(cpi),
        cpiDate: cpi[0]?.date || null,
        coreCpiYoY: yoyChange(coreCpi),
        unemploymentRate: unemployment[0]?.value || null,
        unemploymentDate: unemployment[0]?.date || null,
        nfpChangeThousands: monthlyDelta(nfp),
        nfpDate: nfp[0]?.date || null,
        fedFundsRate: fedFunds[0]?.value || null,
        gdpAnnualizedQoQ: gdpAnnualizedQoQ(gdp),
        gdpDate: gdp[0]?.date || null,
        ppiYoY: yoyChange(ppi),
      },
    };

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=3600', // cache 1 ora, questi dati non cambiano più spesso
      },
      body: JSON.stringify(result),
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
