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

    // Muestra el texto para ajustar o debuggear si hace falta
    console.log('=== CONTENIDO TEXTO PDF ===\n', texto, '\n=== FIN CONTENIDO PDF ===');

    // Number (literalmente el número después de "Number" sin espacio)
    const numeroFactura = texto.match(/Number(\d+)/)?.[1] || 'No encontrado';

    // Date (literalmente el valor después de "Date" sin espacio)
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

    // === AJUSTE ROBUSTO PARA FECHA DE VENCIMIENTO ===
    let fechaVencimientoRaw =
          texto.match(/Due[\s]*date[:\s]*([0-9]{4}[\/\-][0-9]{2}[\/\-][0-9]{2})/i)?.[1]
       || texto.match(/Vence[:\s]*([0-9]{4}[\/\-][0-9]{2}[\/\-][0-9]{2})/i)?.[1]
       || null;
    const fechaVencimiento = formatearFecha(fechaVencimientoRaw);
    // === FIN DEL AJUSTE ===

    // EXTRAER CLIENTE DESPUÉS DE LA CABECERA DescriptionQuantityUnit priceAmount
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

    // Total (la cifra justo antes de 'COP' en la línea de la palabra 'Total')
    let montoTotal = texto.match(/Total\s*([\d\s,.]+)COP/)?.[1];
    if (montoTotal) {
      montoTotal = montoTotal.replace(/\s/g, '').replace(',', '.');
    } else {
      montoTotal = '0.00';
    }

    // Description (la línea justo después de 'Description')
    let descripcion = 'No encontrada';
    const descMatch = texto.match(/Description\s*\n([^\n]+)/);
    if (descMatch) {
      descripcion = descMatch[1].trim();
    }

    // Muestra los datos para depuración (agrega cliente al log)
    console.log('Datos extraídos:', { numeroFactura, fechaEmision, fechaVencimiento, cliente, descripcion, montoTotal });

    // Guardar en SQL Server
    const poolInstance = await getPool();
    await poolInstance.request()
      .input('NumeroFactura', sql.VarChar, numeroFactura)
      .input('FechaEmision', sql.Date, fechaEmision)
      .input('FechaVencimiento', sql.Date, fechaVencimiento)
      .input('Cliente', sql.VarChar, cliente) // AHORA se guarda el cliente real extraído
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
