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
app.use(express.static(path.join(__dirname, 'public')));

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
    valor = valor.replace(/\$/g, '');
    valor = valor.replace(/USD|COP|EUR|MXN/gi, '');
    if (valor.includes('.') && valor.includes(',')) {
      valor = valor.replace(/\./g, '');
      valor = valor.replace(',', '.');
    } else if (valor.includes(',') && !valor.includes('.')) {
      valor = valor.replace(',', '.');
    } else if (valor.includes('.')) {
      const partes = valor.split('.');
      if (partes.length > 2) {
        valor = partes.slice(0, -1).join('') + '.' + partes[partes.length - 1];
      }
    }
  }
  const resultado = parseFloat(valor) || 0;
  return resultado;
}

app.get('/', (req, res) => {
  res.render('index');
});

app.get('/extraerfacturapdf', async (req, res) => {
  try {
    const poolInstance = await getPool();
    const result = await poolInstance.request().query('SELECT * FROM Facturas');
    const facturasFormateadas = result.recordset.map(f => ({
      ...f,
      MontoTotalFormateado: new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
      }).format(parseFloat(f.MontoTotal))
    }));
    res.render('extraerfacturapdf', { facturas: facturasFormateadas });
  } catch (err) {
    console.error('Error al cargar las facturas:', err);
    res.render('extraerfacturapdf', { facturas: [] });
  }
});

app.get('/dashboard', async (req, res) => {
  try {
    const poolInstance = await getPool();

    const result = await poolInstance.request().query(`
      SELECT 
        NumeroFactura,
        FechaEmision,
        Cliente,
        MontoTotal,
        YEAR(FechaEmision) as Anio,
        MONTH(FechaEmision) as Mes
      FROM Facturas
      WHERE FechaEmision IS NOT NULL
      ORDER BY FechaEmision DESC
    `);

    const facturas = result.recordset;

    console.log('=== FACTURAS DESDE BD ===');
    facturas.slice(0, 3).forEach(f => {
      console.log(`#${f.NumeroFactura}: ${f.MontoTotal} (tipo: ${typeof f.MontoTotal})`);
    });

    const extraerServicio = (cliente) => {
      if (!cliente) return 'Sin especificar';

      if (cliente.includes('Servicio localizacion')) {
        const match = cliente.match(/Servicio localizacion \((\d+) disp\.\)/);
        return match ? `Localizacion ${match[1]} dispositivos` : 'Servicio de localizacion';
      }

      if (cliente.includes('Hiber Data Stream')) {
        return 'Hiber Data Stream';
      }

      const nombreBase = cliente.split('-')[0].trim();
      return nombreBase.substring(0, 50);
    };

    const formatearMes = (mesAnio) => {
      const [anio, mes] = mesAnio.split('-');
      const fecha = new Date(anio, parseInt(mes) - 1, 1);
      return fecha.toLocaleDateString('es-ES', { year: 'numeric', month: 'long' });
    };

    const serviciosPorMes = {};

    facturas.forEach(factura => {
      const servicio = extraerServicio(factura.Cliente);
      const mesAnio = `${factura.Anio}-${String(factura.Mes).padStart(2, '0')}`;

      if (!serviciosPorMes[servicio]) {
        serviciosPorMes[servicio] = {};
      }

      if (!serviciosPorMes[servicio][mesAnio]) {
        serviciosPorMes[servicio][mesAnio] = {
          total: 0,
          cantidad: 0,
          facturas: []
        };
      }

      let monto = factura.MontoTotal;
      if (typeof monto === 'string') {
        monto = parseFloat(monto.replace(',', '.'));
      } else {
        monto = parseFloat(monto);
      }

      serviciosPorMes[servicio][mesAnio].total += monto;
      serviciosPorMes[servicio][mesAnio].cantidad += 1;
      serviciosPorMes[servicio][mesAnio].facturas.push({
        numero: factura.NumeroFactura,
        fecha: factura.FechaEmision,
        monto: monto,
        // descripción larga que usará el modal para "Servicios Incluidos"
        descripcion: factura.Cliente
      });
    });

    Object.keys(serviciosPorMes).forEach(servicio => {
      Object.keys(serviciosPorMes[servicio]).forEach(mes => {
        serviciosPorMes[servicio][mes].total =
          Math.round(serviciosPorMes[servicio][mes].total * 1000) / 1000;
      });
    });

    const comparaciones = [];

    Object.keys(serviciosPorMes).forEach(servicio => {
      const meses = Object.keys(serviciosPorMes[servicio]).sort();

      for (let i = 0; i < meses.length; i++) {
        for (let j = i + 1; j < meses.length; j++) {
          const mesAnterior = meses[i];
          const mesActual = meses[j];

          const montoAnterior = serviciosPorMes[servicio][mesAnterior].total;
          const montoActual = serviciosPorMes[servicio][mesActual].total;

          const diferencia = Math.round((montoActual - montoAnterior) * 1000) / 1000;
          const porcentaje = montoAnterior > 0 ?
            Math.round(((diferencia / montoAnterior) * 100) * 100) / 100 : 0;

          let estado = 'estable';
          if (Math.abs(porcentaje) < 5) {
            estado = 'estable';
          } else if (diferencia > 0) {
            estado = 'subio';
          } else {
            estado = 'bajo';
          }

          comparaciones.push({
            servicio,
            mesAnterior: formatearMes(mesAnterior),
            mesActual: formatearMes(mesActual),
            montoAnterior: montoAnterior,
            montoActual: montoActual,
            diferencia: diferencia,
            porcentaje: porcentaje,
            estado,
            cantidadAnterior: serviciosPorMes[servicio][mesAnterior].cantidad,
            cantidadActual: serviciosPorMes[servicio][mesActual].cantidad,
            facturasAnterior: serviciosPorMes[servicio][mesAnterior].facturas,
            facturasActual: serviciosPorMes[servicio][mesActual].facturas
          });
        }
      }
    });

    comparaciones.sort((a, b) => b.mesActual.localeCompare(a.mesActual));

    console.log('=== COMPARACIONES GENERADAS ===');
    comparaciones.forEach(c => {
      console.log(`${c.servicio}: ${c.mesAnterior} ($${c.montoAnterior}) → ${c.mesActual} ($${c.montoActual})`);
    });

    res.render('dashboard', {
      comparaciones,
      serviciosPorMes
    });

  } catch (err) {
    console.error('Error al cargar el dashboard:', err);
    res.status(500).send('Error al cargar el dashboard: ' + err.message);
  }
});

app.get('/dashboard/json', async (req, res) => {
  try {
    const poolInstance = await getPool();
    const result = await poolInstance.request().query(`
      SELECT 
        NumeroFactura,
        FechaEmision,
        Cliente,
        MontoTotal,
        YEAR(FechaEmision) as Anio,
        MONTH(FechaEmision) as Mes
      FROM Facturas
      WHERE FechaEmision IS NOT NULL
      ORDER BY FechaEmision DESC
    `);
    res.json(result.recordset);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// app.post('/extraerfacturapdf', upload.single('factura'), async (req, res) => {
//   try {
//     if (!req.file) throw new Error('No se subió ningún archivo');
//     console.log('Archivo recibido:', req.file.originalname);

//     const dataBuffer = fs.readFileSync(req.file.path);
//     const data = await pdfParse(dataBuffer);
//     const texto = data.text;

//     console.log('===== CONTENIDO PDF COMPLETO =====');
//     console.log(texto);
//     console.log('===== FIN CONTENIDO PDF COMPLETO =====');

//     let tipoPDF = 'DESCONOCIDO';
//     let cliente = 'No encontrado', numeroFactura = 'No encontrado',
//         fechaEmision = null, fechaVencimiento = null, montoTotal = '0.00';

//     if (texto.includes('INVOICE') && texto.includes('INVOICE NUMBER')) {
//       tipoPDF = 'INVOICE_INGLES';
//       numeroFactura = texto.match(/INVOICE NUMBER\s*([^\s]+)/i)?.[1] || 'No encontrado';
//       let fechaMatch = texto.match(/INVOICE DATE\s*([^\n]+)/i);
//       fechaEmision = fechaMatch ? fechaMatch[1].replace(/[^0-9\/\-]/g, '').trim() : null;
//       let clienteMatch = texto.match(/ATTN[:\s]*([^\n]+)/i);
//       cliente = clienteMatch ? clienteMatch[1].replace(/INVOICE NUMBER.*$/, '').trim() : 'No encontrado';
//       let montoMatch = texto.match(/TOTALUSD[\s$]+([\d.,]+)/i) ||
//         texto.match(/TOTAL[\s$]+([\d.,]+)/i) ||
//         texto.match(/AMOUNT[\s$]+([\d.,]+)/i);
//       montoTotal = montoMatch ? limpiarNumero(montoMatch[1]) : '0.00';
//       fechaVencimiento = null;

//       console.log(`[INVOICE] Extraido: num:${numeroFactura} cliente:${cliente} fecha:${fechaEmision} monto:${montoTotal}`);
//     } else if (texto.includes('Global AVL') || texto.includes('Hiber Data Stream')) {
//       tipoPDF = 'FORMATO_GLOBAL_AVL';

//       const facturaMatch = texto.match(/Factura\s+([A-Za-z0-9\-]+)/i);
//       numeroFactura = facturaMatch ? facturaMatch[1] : 'No encontrado';

//       const fechaMatch = texto.match(/Fecha:\s*(\d{4})\/(\d{2})\/(\d{2})/);
//       fechaEmision = fechaMatch ? `${fechaMatch[1]}-${fechaMatch[2]}-${fechaMatch[3]}` : null;

//       const clienteMatch = texto.match(/Cliente:\s*([\s\S]*?)(?=RUT:)/i);
//       cliente = clienteMatch ? clienteMatch[1].replace(/\n+/g, ' ').replace(/\s{2,}/g, ' ').trim() : "No encontrado";

//       let descripcionServicios = '';
//       const lineas = texto.split('\n');
//       for (let linea of lineas) {
//         linea = linea.trim();
//         const servicioMatch = linea.match(/^(\d+)\s*Servicio de localizacion[^\d]*([\d,\.]+)[^\$]*\$(\d[\d,\.]*)\s*\$/i);
//         if (servicioMatch) {
//           const cantidad = servicioMatch[2].replace(/,/g, '').replace(/\./g,'');
//           const desc = `Servicio localizacion (${cantidad} disp.)`;
//           descripcionServicios += `${desc}; `;
//         }
//       }
//       if (descripcionServicios) {
//         cliente += " - " + descripcionServicios.trim();
//       }

//       let totalMatch = texto.match(/Total\s*([\d.,]+)\s*\$/i);
//       montoTotal = totalMatch ? limpiarNumero(totalMatch[1]) : '0.00';
//       fechaVencimiento = null;

//       console.log(`[GLOBAL AVL] Extraido: num:${numeroFactura} cliente:${cliente} fecha:${fechaEmision} monto:${montoTotal}`);
//     } else if (texto.includes('DescriptionQuantityUnit priceAmount')) {
//       tipoPDF = 'FORMATO_CLASICO';
//       numeroFactura = texto.match(/Number(\d+)/)?.[1] || 'No encontrado';
//       const fechaEmisionRaw = texto.match(/Date(\d{4}\/\d{2}\/\d{2})/)?.[1] || null;
//       fechaEmision = fechaEmisionRaw;
//       const marker = 'DescriptionQuantityUnit priceAmount';
//       const inicioDetalles = texto.indexOf(marker);
//       const finTablaRegex = /(?:Amount|Valor total)/i;
//       let clienteBloque = '';
//       if (inicioDetalles !== -1) {
//         const resto = texto.substring(inicioDetalles + marker.length);
//         const lineas = resto.split('\n');
//         for (let linea of lineas) {
//           if (finTablaRegex.test(linea)) break;
//           clienteBloque += linea.trim() + ' ';
//         }
//         cliente = clienteBloque.replace(/\s{2,}/g, ' ').trim();
//       } else {
//         cliente = texto.split(marker)[1] ? texto.split(marker)[1].split('\n')[0].trim() : "No encontrado";
//       }

//       let lineaCOP = texto.split('\n').find(l => l.includes('COP'));
//       if (lineaCOP) {
//         const montos = Array.from(lineaCOP.matchAll(/(\d[\d\s.]*\d,\d{2})/g)).map(m =>
//           limpiarNumero(m[1])
//         );
//         if (montos.length) montoTotal = Math.max(...montos).toFixed(2);
//       }
//     }

//     if (tipoPDF === 'DESCONOCIDO') {
//       cliente = texto.slice(0, 120).replace(/\n/g, ' ');
//       numeroFactura = 'No encontrado';
//       fechaEmision = null;
//       montoTotal = '0.00';
//     }

//     const poolInstance = await getPool();
//     const montoFinal = limpiarNumero(montoTotal);

//     console.log(`Guardando en BD - Cliente: "${cliente}"`);
//     console.log(`Guardando en BD - MontoTotal: ${montoFinal} (tipo: ${typeof montoFinal})`);

//     await poolInstance.request()
//       .input('NumeroFactura', sql.VarChar, numeroFactura)
//       .input('FechaEmision', sql.Date, fechaEmision)
//       .input('FechaVencimiento', sql.Date, fechaVencimiento)
//       .input('Cliente', sql.VarChar, cliente)
//       .input('MontoTotal', sql.Decimal(18,4), montoFinal)
//       .query(`
//         INSERT INTO Facturas (NumeroFactura, FechaEmision, FechaVencimiento, Cliente, MontoTotal)
//         VALUES (@NumeroFactura, @FechaEmision, @FechaVencimiento, @Cliente, @MontoTotal)
//       `);

//     res.redirect('/extraerfacturapdf');
//   } catch (error) {
//     console.error('Error al procesar la factura:', error);
//     res.status(500).send('Error al procesar la factura: ' + error.message + '<br>' + error.stack);
//   }
// });
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

    let tipoPDF = 'DESCONOCIDO';
    let cliente = 'No encontrado', numeroFactura = 'No encontrado',
        fechaEmision = null, fechaVencimiento = null, montoTotal = '0.00';

    if (texto.includes('INVOICE') && texto.includes('INVOICE NUMBER')) {
      tipoPDF = 'INVOICE_INGLES';
      numeroFactura = texto.match(/INVOICE NUMBER\s*([^\s]+)/i)?.[1] || 'No encontrado';
      let fechaMatch = texto.match(/INVOICE DATE\s*([^\n]+)/i);
      fechaEmision = fechaMatch ? fechaMatch[1].replace(/[^0-9\/\-]/g, '').trim() : null;
      let clienteMatch = texto.match(/ATTN[:\s]*([^\n]+)/i);
      cliente = clienteMatch ? clienteMatch[1].replace(/INVOICE NUMBER.*$/, '').trim() : 'No encontrado';
      
      // Extraer todo el bloque desde la dirección hasta TOTAL
      const bloqueMatch = texto.match(/Westlake Village.*?\n([\s\S]*?)TOTAL\s*USD/i);
      if (bloqueMatch) {
        let descripcionCompleta = bloqueMatch[1]
          .replace(/ATTN:.*?(?=Securitas Intelligent|INVOICE)/gi, '') // Remover ATTN ya capturado
          .replace(/INVOICE NUMBER.*?\n/gi, '')
          .replace(/INVOICE DATE.*?\n/gi, '')
          .replace(/DATE\s*AMOUNT/gi, '')
          .replace(/\n\s*\n/g, '\n') // Eliminar líneas vacías múltiples
          .trim()
          .split('\n')
          .map(line => line.trim())
          .filter(line => line.length > 0)
          .join(' ');
        
        if (descripcionCompleta) {
          cliente += ' - ' + descripcionCompleta;
        }
      }
      
      let montoMatch = texto.match(/TOTALUSD[\s$]+([\d.,]+)/i) ||
        texto.match(/TOTAL[\s$]+([\d.,]+)/i) ||
        texto.match(/AMOUNT[\s$]+([\d.,]+)/i);
      montoTotal = montoMatch ? limpiarNumero(montoMatch[1]) : '0.00';
      fechaVencimiento = null;

      console.log(`[INVOICE] Extraido: num:${numeroFactura} cliente:${cliente} fecha:${fechaEmision} monto:${montoTotal}`);
    } else if (texto.includes('Global AVL') || texto.includes('Hiber Data Stream')) {
      tipoPDF = 'FORMATO_GLOBAL_AVL';

      const facturaMatch = texto.match(/Factura\s+([A-Za-z0-9\-]+)/i);
      numeroFactura = facturaMatch ? facturaMatch[1] : 'No encontrado';

      const fechaMatch = texto.match(/Fecha:\s*(\d{4})\/(\d{2})\/(\d{2})/);
      fechaEmision = fechaMatch ? `${fechaMatch[1]}-${fechaMatch[2]}-${fechaMatch[3]}` : null;

      const clienteMatch = texto.match(/Cliente:\s*([\s\S]*?)(?=RUT:)/i);
      cliente = clienteMatch ? clienteMatch[1].replace(/\n+/g, ' ').replace(/\s{2,}/g, ' ').trim() : "No encontrado";

      // Extraer descripción completa de servicios
      let descripcionServicios = '';
      const lineas = texto.split('\n');
      let totalDispositivos = 0;
      
      for (let linea of lineas) {
        linea = linea.trim();
        // Buscar líneas que contienen "Servicio de localizacion"
        const servicioMatch = linea.match(/Servicio de localizacion\s+(.+?)\s+(\d+(?:[.,]\d+)?)\s+(\d+(?:[.,]\d+)?)\s*\$\s*(\d+(?:[.,]\d+)?)\s*\$/i);
        if (servicioMatch) {
          const rangoDispositivos = servicioMatch[1].trim();
          const cantidad = parseInt(servicioMatch[2].replace(/[.,]/g, ''));
          const precio = servicioMatch[3];
          const total = servicioMatch[4];
          
          if (cantidad > 0) {
            totalDispositivos += cantidad;
            descripcionServicios += `${cantidad} dispositivos (${rangoDispositivos}) a $${precio} = $${total}; `;
          }
        }
      }
      
      if (descripcionServicios) {
        cliente += ` - Total: ${totalDispositivos} dispositivos - Detalle: ${descripcionServicios.trim()}`;
      }

      let totalMatch = texto.match(/Total\s*([\d.,]+)\s*\$/i);
      montoTotal = totalMatch ? limpiarNumero(totalMatch[1]) : '0.00';
      fechaVencimiento = null;

      console.log(`[GLOBAL AVL] Extraido: num:${numeroFactura} cliente:${cliente} fecha:${fechaEmision} monto:${montoTotal}`);
    } else if (texto.includes('DescriptionQuantityUnit priceAmount')) {
      tipoPDF = 'FORMATO_CLASICO';
      numeroFactura = texto.match(/Number(\d+)/)?.[1] || 'No encontrado';
      const fechaEmisionRaw = texto.match(/Date(\d{4}\/\d{2}\/\d{2})/)?.[1] || null;
      fechaEmision = fechaEmisionRaw;
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
        cliente = clienteBloque.replace(/\s{2,}/g, ' ').trim();
      } else {
        cliente = texto.split(marker)[1] ? texto.split(marker)[1].split('\n')[0].trim() : "No encontrado";
      }

      let lineaCOP = texto.split('\n').find(l => l.includes('COP'));
      if (lineaCOP) {
        const montos = Array.from(lineaCOP.matchAll(/(\d[\d\s.]*\d,\d{2})/g)).map(m =>
          limpiarNumero(m[1])
        );
        if (montos.length) montoTotal = Math.max(...montos).toFixed(2);
      }
    }

    if (tipoPDF === 'DESCONOCIDO') {
      cliente = texto.slice(0, 120).replace(/\n/g, ' ');
      numeroFactura = 'No encontrado';
      fechaEmision = null;
      montoTotal = '0.00';
    }

    const poolInstance = await getPool();
    const montoFinal = limpiarNumero(montoTotal);

    console.log(`Guardando en BD - Cliente: "${cliente}"`);
    console.log(`Guardando en BD - MontoTotal: ${montoFinal} (tipo: ${typeof montoFinal})`);

    await poolInstance.request()
      .input('NumeroFactura', sql.VarChar, numeroFactura)
      .input('FechaEmision', sql.Date, fechaEmision)
      .input('FechaVencimiento', sql.Date, fechaVencimiento)
      .input('Cliente', sql.VarChar, cliente)
      .input('MontoTotal', sql.Decimal(18,4), montoFinal)
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
app.get('/debug-facturas', async (req, res) => {
  // Igual que antes (si decides implementarlo)
});

iniciarServidor();
