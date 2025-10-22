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

let pool;

async function iniciarServidor() {
  try {
    pool = await sql.connect(dbconfig);
    console.log('✅ Base de datos conectada correctamente');

    const PORT = 3000;
    app.listen(PORT, () => {
      console.log(`Servidor corriendo en http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error('❌ Error al conectar la base de datos:', err);
  }
}

async function getPool() {
  if (!pool) {
    pool = await sql.connect(dbconfig);
  }
  return pool;
}

// Página principal
app.get('/', (req, res) => {
  res.render('index', { factura: null });
});

// Formulario para subir factura
app.get('/extraerfacturapdf', (req, res) => {
  res.render('extraerfacturapdf', { factura: null });
});

app.post('/extraerfacturapdf', upload.single('factura'), async (req, res) => {
  try {
    if (!req.file) throw new Error('No se subió ningún archivo');
    console.log('Archivo recibido:', req.file.originalname);

    const dataBuffer = fs.readFileSync(req.file.path);
    console.log('Tamaño del buffer:', dataBuffer.length);

    const data = await pdfParse(dataBuffer);
    const texto = data.text;

    // Muestra el texto para debug
    console.log('=== CONTENIDO TEXTO PDF ===\n', texto, '\n=== FIN CONTENIDO PDF ===');

    // Number
    const numeroFactura = texto.match(/Number(\d+)/)?.[1] || 'No encontrado';

    // Date
    const fechaEmisionRaw = texto.match(/Date(\d{4}\/\d{2}\/\d{2})/)?.[1] || null;
    function formatearFecha(fechaStr) {
      if (!fechaStr) return null;
      const partes = fechaStr.split('/');
      if (partes.length !== 3) return null;
      const [anio, mes, dia] = partes;
      const fechaISO = `${anio}-${mes}-${dia}`;
      if (isNaN(Date.parse(fechaISO))) return null;
      return fechaISO;
    }
    const fechaEmision = formatearFecha(fechaEmisionRaw);

    // Fecha de vencimiento
    let fechaVencimientoRaw =
      texto.match(/Due[\s]*date[:\s]*([0-9]{4}[\/\-][0-9]{2}[\/\-][0-9]{2})/i)?.[1]
      || texto.match(/Vence[:\s]*([0-9]{4}[\/\-][0-9]{2}[\/\-][0-9]{2})/i)?.[1]
      || null;
    const fechaVencimiento = formatearFecha(fechaVencimientoRaw);

    // Cliente (después del bloque DescriptionQuantityUnit priceAmount)
    let cliente = 'No encontrado';
    const cliMatch = texto.match(/DescriptionQuantityUnit priceAmount\s*\n([^\n]+)(?:\n([^\n]+))?/);
    if (cliMatch) {
      cliente = cliMatch[1].trim();
      if (cliMatch[2]) {
        const segundaLinea = cliMatch[2].trim();
        if (/^[A-ZÁÉÍÓÚÑ]/.test(segundaLinea)) {
          cliente += ' ' + segundaLinea;
        }
      }
    }

    // Description (línea después de 'Description')
    let descripcion = 'No encontrada';
    const descMatch = texto.match(/Description\s*\n([^\n]+)/);
    if (descMatch) {
      descripcion = descMatch[1].trim();
    }

    // === MONTO TOTAL: SIEMPRE EL NÚMERO COMPLETO ANTES DEL ÚLTIMO "COP" ===
    // === BLOQUE QUE TOMA EL MONTO MAYOR EN LA LÍNEA QUE CONTIENE "COP" ===
let montoTotal = '0.00';
const lineaCOP = texto.split('\n').find(l => l.includes('COP'));
if (lineaCOP) {
  // Extrae todos los montos decimales
  const montos = Array.from(lineaCOP.matchAll(/(\d[\d\s.]*\d,\d{2})/g)).map(m => parseFloat(m[1].replace(/\s/g, '').replace(',', '.')));
  if (montos.length) {
    // Toma el MAYOR (el total de la factura casi siempre es el monto más grande)
    montoTotal = Math.max(...montos).toFixed(2);
  }
}


    // Muestra los datos para depuración
    console.log('Datos extraídos:', {
      numeroFactura, fechaEmision, fechaVencimiento, cliente, descripcion, montoTotal
    });

    // Guardar en SQL Server
    const poolInstance = await getPool();
    await poolInstance.request()
      .input('NumeroFactura', sql.VarChar, numeroFactura)
      .input('FechaEmision', sql.Date, fechaEmision)
      .input('FechaVencimiento', sql.Date, fechaVencimiento)
      .input('Cliente', sql.VarChar, cliente)
      .input('MontoTotal', sql.VarChar, montoTotal)
      .query(`
        INSERT INTO Facturas 
        (NumeroFactura, FechaEmision, FechaVencimiento, Cliente, MontoTotal)
        VALUES (@NumeroFactura, @FechaEmision, @FechaVencimiento, @Cliente, @MontoTotal)
      `);

    res.render('extraerfacturapdf', {
      factura: { numeroFactura, fechaEmision, fechaVencimiento, cliente, descripcion, montoTotal }
    });

  } catch (err) {
    console.error('❌ Error al procesar el archivo PDF:', err);
    res.status(500).send(`Error al procesar el archivo PDF: ${err.message}`);
  }
});









iniciarServidor();
