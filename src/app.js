const express = require('express');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const sql = require('mssql');
const dbconfig = require('./dbconfig');
const pdfParse = require('pdf-parse');

const app = express();
const upload = multer({ dest: 'uploads/' });

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static('uploads'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static('public'));
let pool;

async function iniciarServidor() {
  try {
    pool = await sql.connect(dbconfig);
    console.log('Base de datos conectada correctamente');
    const PORT = 3000;
    app.listen(PORT, () => {
      console.log(`Servidor corriendo en http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error('Error al conectar la base de datos:', err);
  }
}

async function getPool() {
  if (!pool) {
    pool = await sql.connect(dbconfig);
  }
  return pool;
}

function limpiarNumero(valor) {
  if (typeof valor === 'string') {
    valor = valor.replace(/\s/g, '');
    valor = valor.replace(/\./g, '');
    valor = valor.replace(',', '.');
  }
  return parseFloat(valor) || 0;
}

app.get('/', (req, res) => {
  res.render('index');
});

app.get('/dashboard', async (req, res) => {
  try {
    const pool = await sql.connect(dbconfig);
    const result = await pool.request().query(`
      SELECT 
          NumeroFactura,
          Cliente,
          FORMAT(FechaEmision, 'yyyy-MM') AS Mes,
          MontoTotal
      FROM Facturas
      WHERE FechaEmision IS NOT NULL
      ORDER BY Mes, NumeroFactura;
    `);

    const facturas = result.recordset.map(f => ({
      NumeroFactura: f.NumeroFactura,
      Cliente: f.Cliente,
      Mes: f.Mes,
      MontoTotal: parseFloat(f.MontoTotal)
    }));

    // Agrupar por mes para calcular total mensual
    const totalesPorMes = {};
    facturas.forEach(f => {
      if (!totalesPorMes[f.Mes]) totalesPorMes[f.Mes] = 0;
      totalesPorMes[f.Mes] += f.MontoTotal;
    });

    // Crear arreglo ordenado de meses
    const mesesOrdenados = Object.keys(totalesPorMes).sort();

    // Asignar estado por comparación mes a mes
    const estadosPorMes = {};
    mesesOrdenados.forEach((mes, i) => {
      if (i === 0) {
        estadosPorMes[mes] = 'Activo';
      } else {
        const anterior = totalesPorMes[mesesOrdenados[i - 1]];
        const actual = totalesPorMes[mes];
        if (actual > anterior) estadosPorMes[mes] = 'Subió';
        else if (actual < anterior) estadosPorMes[mes] = 'Bajó';
        else estadosPorMes[mes] = 'Activo';
      }
    });
    // Agregar el estado a cada factura según su mes
    const datos = facturas.map(f => ({
      NumeroFactura: f.NumeroFactura,
      Cliente: f.Cliente,
      Mes: f.Mes,
      TotalMes: totalesPorMes[f.Mes],
      Estado: estadosPorMes[f.Mes]
    }));

    res.render('dashboard', { datos });
  } catch (err) {
    console.error('Error al generar dashboard:', err);
    res.status(500).send('Error al generar el dashboard');
  }
});

app.get('/extraerfacturapdf', async (req, res) => {
  try {
    const poolInstance = await getPool();
    const result = await poolInstance.request().query('SELECT * FROM Facturas');
    res.render('extraerfacturapdf', { facturas: result.recordset });
  } catch (err) {
    console.error('Error al cargar las facturas:', err);
    res.render('extraerfacturapdf', { facturas: [] });
  }
});

app.post('/extraerfacturapdf', upload.single('factura'), async (req, res) => {
  try {
    if (!req.file) throw new Error('No se subió ningún archivo');
    console.log('Archivo recibido:', req.file.originalname);

    const dataBuffer = fs.readFileSync(req.file.path);
    const data = await pdfParse(dataBuffer);
    const texto = data.text;

    console.log('===== CONTENIDO PDF COMPLETO =====');
    console.log(texto);
    console.log('===== FIN CONTENIDO PDF COMPLETO =====');

    // Inicializar campos
    let tipoPDF = 'DESCONOCIDO';
    let cliente = 'No encontrado', numeroFactura = 'No encontrado', fechaEmision = null, fechaVencimiento = null, montoTotal = '0.00';

    if (texto.includes('DescriptionQuantityUnit priceAmount')) {
      // FORMATO_CLASICO
      tipoPDF = 'FORMATO_CLASICO';
      numeroFactura = texto.match(/Number(\d+)/)?.[1] || 'No encontrado';
      const fechaEmisionRaw = texto.match(/Date(\d{4}\/\d{2}\/\d{2})/)?.[1] || null;
      const fechaVencimientoRaw =
        texto.match(/Due[\s]*date[:\s]*([0-9]{4}[\/\-][0-9]{2}[\/\-][0-9]{2})/i)?.[1]
        || texto.match(/Vence[:\s]*([0-9]{4}[\/\-][0-9]{2}[\/\-][0-9]{2})/i)?.[1]
        || null;
      function formatearFecha(fechaStr) {
        if (!fechaStr) return null;
        const partes = fechaStr.split('/');
        if (partes.length !== 3) return null;
        const [anio, mes, dia] = partes;
        const fechaISO = `${anio}-${mes}-${dia}`;
        if (isNaN(Date.parse(fechaISO))) return null;
        return fechaISO;
      }
      fechaEmision = formatearFecha(fechaEmisionRaw);
      fechaVencimiento = formatearFecha(fechaVencimientoRaw);

      const marker = 'DescriptionQuantityUnit priceAmount';
      const inicioDetalles = texto.indexOf(marker);
      const finTablaRegex = /(?:Amount|Valor total)/i;
      let clienteBloque = '';
      if (inicioDetalles !== -1) {
        const resto = texto.substring(inicioDetalles + marker.length);
        const lineas = resto.split('\n');
        for (let linea of lineas) {
          if (finTablaRegex.test(linea)) break;
          clienteBloque += linea.trim() + ' ';
        }
        cliente = clienteBloque.trim();
      } else {
        const cliMatch = texto.match(/DescriptionQuantityUnit priceAmount\s*\n([^\n]+\n[^\n]+\n[^\n]+)/);
        if (cliMatch) {
          cliente = cliMatch[1].replace(/\n+/g, ' ').trim();
        }
      }

      const lineaCOP = texto.split('\n').find(l => l.includes('COP'));
      if (lineaCOP) {
        const montos = Array.from(lineaCOP.matchAll(/(\d[\d\s.]*\d,\d{2})/g)).map(m =>
          limpiarNumero(m[1])
        );
        if (montos.length) montoTotal = Math.max(...montos).toFixed(2);
      }

    } else if (texto.includes('Factura Electrónica') && texto.includes('NIT')) {
      // FORMATO_ELECTRONICO_COLOMBIANO
      tipoPDF = 'FORMATO_ELECTRONICO_COLOMBIANO';
      numeroFactura = texto.match(/Factura\s*N[°º]?\s*[:\-]?\s*(\d+)/i)?.[1] || 'No encontrado';
      const fechaEmisionRaw = texto.match(/Fecha\s*[:\-]?\s*([0-9]{2}\/[0-9]{2}\/[0-9]{4})/i)?.[1] || null;
      fechaEmision = fechaEmisionRaw;
      fechaVencimiento = null;
      const cliMatch = texto.match(/Cliente\s*:\s*(.*?)\s*NIT/i);
      if (cliMatch) cliente = cliMatch[1].trim();

      const descMatch = texto.match(/Descripción:\s*([\s\S]*?)Total:/i);
      if (descMatch) cliente += "\n" + descMatch[1].trim();

      let montoMatch = texto.match(/Total\s*:?[\s$]*([\d.,]+)/i);
      if (montoMatch) montoTotal = limpiarNumero(montoMatch[1]);
    } else if (texto.includes('INVOICE') && texto.includes('INVOICE NUMBER')) {
      // INVOICE EN INGLÉS (DETALLES TRAS DATEAMOUNT)
      tipoPDF = 'INVOICE_INGLES';
      numeroFactura = texto.match(/INVOICE NUMBER\s*([^\s]+)/i)?.[1] || 'No encontrado';
      let fechaMatch = texto.match(/INVOICE DATE\s*([^\s]+)/i);
      fechaEmision = fechaMatch ? fechaMatch[1].replace(/[^0-9\/]/g, '') : null;

      // Bloque de detalles tras DATEAMOUNT
      const inicio = texto.indexOf('DATEAMOUNT');
      let fin = texto.indexOf('If you have any questions');
      if (fin === -1) fin = texto.length;

      let detalles = 'No encontrado';
      if (inicio !== -1 && fin > inicio) {
        detalles = texto.substring(inicio + 'DATEAMOUNT'.length, fin).trim();
      }

      cliente = detalles.replace(/\n{2,}/g, '\n').replace(/\n/g, ' ').replace(/[ ]{2,}/g, ' ').trim();

      let montoMatch = texto.match(/TOTALUSD[\s$]+([\d.,]+)/i) ||
        texto.match(/TOTAL[\s$]+([\d.,]+)/i);
      montoTotal = montoMatch ? limpiarNumero(montoMatch[1]) : '0.00';
    }

    if (tipoPDF === 'DESCONOCIDO') {
      cliente = texto.slice(0, 500);
      numeroFactura = 'No encontrado';
      fechaEmision = null;
      montoTotal = '0.00';
    }

    console.log({
      tipoPDF,
      numeroFactura,
      fechaEmision,
      fechaVencimiento,
      cliente,
      montoTotal
    });

    const poolInstance = await getPool();
    await poolInstance.request()
      .input('NumeroFactura', sql.VarChar, numeroFactura)
      .input('FechaEmision', sql.Date, fechaEmision)
      .input('FechaVencimiento', sql.Date, fechaVencimiento)
      .input('Cliente', sql.VarChar, cliente)
      .input('MontoTotal', sql.Decimal(18,2), limpiarNumero(montoTotal))
      .query(`
        INSERT INTO Facturas (NumeroFactura, FechaEmision, FechaVencimiento, Cliente, MontoTotal)
        VALUES (@NumeroFactura, @FechaEmision, @FechaVencimiento, @Cliente, @MontoTotal)
      `);

    res.redirect('/extraerfacturapdf');
  } catch (error) {
    console.error('Error al procesar la factura:', error);
    res.status(500).send('Error al procesar la factura: ' + error.message + '<br>' + error.stack);
  }
});

iniciarServidor();
