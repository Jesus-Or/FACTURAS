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
app.set('views', path.join(__dirname, 'views', ));
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

// Procesar PDF
app.post('/extraerfacturapdf', upload.single('factura'), async (req, res) => {
  try {
    if (!req.file) throw new Error('No se subió ningún archivo');
    console.log('Archivo recibido:', req.file.originalname);

    const dataBuffer = fs.readFileSync(req.file.path);
    console.log('Tamaño del buffer:', dataBuffer.length);

    const data = await pdfParse(dataBuffer);
    const texto = data.text;

    // Extraer datos

function formatearFecha(fechaStr) {
  if (!fechaStr) return null;
  // Convierte "YYYY/MM/DD" a "YYYY-MM-DD"
  return fechaStr.replace(/\//g, '-');
}

// Extraer fechas como YYYY/MM/DD desde el PDF
const numeroFactura = texto.match(/Invoice\s+(\d+)/)?.[1] || 'No encontrado';
const fechaEmisionRaw = texto.match(/Date\s+(\d{4}\/\d{2}\/\d{2})/)?.[1] || null;
const fechaVencimientoRaw = texto.match(/Due date\s+(\d{4}\/\d{2}\/\d{2})/)?.[1] || null;
const cliente = texto.match(/Description\s+Colombia/) ? 'Securitas Colombia' : 'Desconocido';
const montoTotal = texto.match(/(\d{1,3}(?: \d{3})*,\d{2})\s*COP/)?.[1]?.replace(/\s/g, '') || '0,00';

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
const fechaVencimiento = formatearFecha(fechaVencimientoRaw);

console.log('Datos extraídos:', { numeroFactura, fechaEmision, fechaVencimiento, cliente, montoTotal });


    // Guardar en SQL Server usando parámetros
    const poolInstance = await getPool();
    await poolInstance.request()
      .input('NumeroFactura', sql.VarChar, numeroFactura)
      .input('FechaEmision', sql.Date, fechaEmision)
      .input('FechaVencimiento', sql.Date, fechaVencimiento)
      .input('Cliente', sql.VarChar, cliente)
      .input('MontoTotal', sql.VarChar, montoTotal)
      .query(`
        INSERT INTO Facturas (NumeroFactura, FechaEmision, FechaVencimiento, Cliente, MontoTotal)
        VALUES (@NumeroFactura, @FechaEmision, @FechaVencimiento, @Cliente, @MontoTotal)
      `);

    res.render('extraerfacturapdf', {
      factura: { numeroFactura, fechaEmision, fechaVencimiento, cliente, montoTotal }
    });

  } catch (err) {
    console.error('❌ Error al procesar el archivo PDF:', err);
    res.status(500).send(`Error al procesar el archivo PDF: ${err.message}`);
  }
});

iniciarServidor();
