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
    // Eliminar espacios
    valor = valor.replace(/\s/g, '');
    // Eliminar símbolo de dólar si existe
    valor = valor.replace(/\$/g, '');
    // Eliminar USD, COP, EUR, etc.
    valor = valor.replace(/USD|COP|EUR|MXN/gi, '');
    
    // Si tiene tanto punto como coma, es formato europeo (punto=miles, coma=decimal)
    if (valor.includes('.') && valor.includes(',')) {
      valor = valor.replace(/\./g, ''); // Eliminar puntos (miles)
      valor = valor.replace(',', '.'); // Convertir coma a punto (decimal)
    } else if (valor.includes(',') && !valor.includes('.')) {
      // Solo tiene coma, es el decimal (formato europeo)
      valor = valor.replace(',', '.');
    } else if (valor.includes('.')) {
      // Verificar si es formato americano (punto como decimal)
      // Si hay solo un punto y menos de 4 dígitos después, es decimal
      // Si hay múltiples puntos o más de 3 dígitos, el último punto es decimal
      const partes = valor.split('.');
      if (partes.length > 2) {
        // Múltiples puntos: puntos son separadores de miles
        valor = partes.slice(0, -1).join('') + '.' + partes[partes.length - 1];
      }
      // Si tiene un solo punto, ya está en formato correcto
    }
  }
  const resultado = parseFloat(valor) || 0;
  return resultado;
}

// Función para extraer servicios del texto de la factura
function extraerServicios(textoCliente) {
  const servicios = [];
  
  // Patrón 1: Servicios Global IT - Formato: "Global IT Services - CERT (Digital Security)1,0013 541 751,00"
  const patronGlobalIT = /Global IT Services - ([^0-9]+?)(\d+),(\d+)([\d\s,.]+)/g;
  let match;
  
  while ((match = patronGlobalIT.exec(textoCliente)) !== null) {
    const nombreServicio = match[1].trim();
    const cantidadEntera = match[2];
    const cantidadDecimal = match[3];
    const cantidad = parseFloat(`${cantidadEntera}.${cantidadDecimal}`) || 0;
    
    if (cantidad > 0 && nombreServicio) {
      servicios.push({
        nombre: nombreServicio,
        cantidad: cantidad
      });
    }
  }
  
  // Patrón 2: Office 365 Licences - Formato: "Extra Light Frontline Worker210 740,74"
  const patronOffice365 = /(Extra Light Frontline Worker|Light|Extended standard|Extended advanced|Frontline Shared Account)\s*(\d+)\s*([\d\s.,]+)/g;
  
  while ((match = patronOffice365.exec(textoCliente)) !== null) {
    const nombreServicio = match[1].trim();
    const cantidad = parseInt(match[2]) || 0;
    
    if (cantidad > 0 && nombreServicio) {
      servicios.push({
        nombre: `Office 365 - ${nombreServicio}`,
        cantidad: cantidad
      });
    }
  }
  
  // Patrón 3: Global Guarding Platform - Formato: "Global Guarding Platform - TrackTik1,00"
  const patronGuarding = /Global Guarding Platform - ([^0-9]+?)(\d+),(\d+)/g;
  
  while ((match = patronGuarding.exec(textoCliente)) !== null) {
    const nombreServicio = match[1].trim();
    const cantidadEntera = match[2];
    const cantidadDecimal = match[3];
    const cantidad = parseFloat(`${cantidadEntera}.${cantidadDecimal}`) || 0;
    
    if (cantidad > 0 && nombreServicio) {
      servicios.push({
        nombre: `Global Guarding Platform - ${nombreServicio}`,
        cantidad: cantidad
      });
    }
  }
  
  // Patrón 4: Mark-up services - Formato: "Mark-up Digital identity1,00"
  const patronMarkup = /Mark-up\s*-?\s*([^0-9]+?)(\d+),(\d+)/g;
  
  while ((match = patronMarkup.exec(textoCliente)) !== null) {
    const nombreServicio = match[1].trim();
    const cantidadEntera = match[2];
    const cantidadDecimal = match[3];
    const cantidad = parseFloat(`${cantidadEntera}.${cantidadDecimal}`) || 0;
    
    if (cantidad > 0 && nombreServicio) {
      servicios.push({
        nombre: `Mark-up - ${nombreServicio}`,
        cantidad: cantidad
      });
    }
  }
  
  return servicios;
}

app.get('/', (req, res) => {
  res.render('index');
});

// RUTA ORIGINAL: Dashboard por Mes
app.get('/dashboard', async (req, res) => {
  try {
    const pool = await sql.connect(dbconfig);
    const result = await pool.request().query(`
      SELECT 
          NumeroFactura,
          Cliente,
          FechaEmision,
          YEAR(FechaEmision) AS Anio,
          MONTH(FechaEmision) AS MesNumero,
          DATENAME(MONTH, FechaEmision) AS MesNombre,
          MontoTotal
      FROM Facturas
      WHERE FechaEmision IS NOT NULL
      ORDER BY FechaEmision;
    `);

    const mesesEspanol = {
      'January': 'Enero',
      'February': 'Febrero',
      'March': 'Marzo',
      'April': 'Abril',
      'May': 'Mayo',
      'June': 'Junio',
      'July': 'Julio',
      'August': 'Agosto',
      'September': 'Septiembre',
      'October': 'Octubre',
      'November': 'Noviembre',
      'December': 'Diciembre'
    };

    // Extraer servicios de cada factura y agrupar por mes
    const serviciosPorMes = {};
    
    result.recordset.forEach(factura => {
      const anioMes = `${factura.Anio}-${String(factura.MesNumero).padStart(2, '0')}`;
      const mesNombre = mesesEspanol[factura.MesNombre] || factura.MesNombre;
      
      if (!serviciosPorMes[anioMes]) {
        serviciosPorMes[anioMes] = {
          anio: factura.Anio,
          mesNumero: factura.MesNumero,
          mesNombre: mesNombre,
          servicios: {}
        };
      }
      
      // Extraer servicios del campo Cliente
      const clienteCompleto = factura.Cliente || '';
      const serviciosEncontrados = extraerServicios(clienteCompleto);
      
      serviciosEncontrados.forEach(servicio => {
        const nombreServicio = servicio.nombre;
        const cantidad = servicio.cantidad;
        
        if (!serviciosPorMes[anioMes].servicios[nombreServicio]) {
          serviciosPorMes[anioMes].servicios[nombreServicio] = {
            nombre: nombreServicio,
            cantidad: 0,
            facturas: []
          };
        }
        
        serviciosPorMes[anioMes].servicios[nombreServicio].cantidad += cantidad;
        serviciosPorMes[anioMes].servicios[nombreServicio].facturas.push({
          numero: factura.NumeroFactura,
          fecha: factura.FechaEmision,
          cantidad: cantidad
        });
      });
    });

    // Convertir a array y ordenar cronológicamente
    const mesesOrdenados = Object.keys(serviciosPorMes).sort();
    
    // Calcular estados para cada servicio
    const dashboardData = [];
    
    mesesOrdenados.forEach((anioMes, index) => {
      const mesActual = serviciosPorMes[anioMes];
      const serviciosConEstado = [];
      
      Object.values(mesActual.servicios).forEach(servicio => {
        let estado = 'Nuevo';
        let diferencia = 0;
        let cantidadAnterior = 0;
        
        // Buscar el mismo servicio en el mes anterior
        if (index > 0) {
          const anioMesAnterior = mesesOrdenados[index - 1];
          const mesAnterior = serviciosPorMes[anioMesAnterior];
          
          if (mesAnterior.servicios[servicio.nombre]) {
            cantidadAnterior = mesAnterior.servicios[servicio.nombre].cantidad;
            diferencia = servicio.cantidad - cantidadAnterior;
            
            if (diferencia > 0) {
              estado = 'Subió';
            } else if (diferencia < 0) {
              estado = 'Bajó';
            } else {
              estado = 'Estable';
            }
          }
        }
        
        serviciosConEstado.push({
          nombre: servicio.nombre,
          cantidad: servicio.cantidad,
          cantidadAnterior: cantidadAnterior,
          diferencia: diferencia,
          estado: estado,
          facturas: servicio.facturas
        });
      });
      
      // Calcular total del mes
      const totalMes = serviciosConEstado.reduce((sum, s) => sum + s.cantidad, 0);
      
      dashboardData.push({
        anioMes: anioMes,
        anio: mesActual.anio,
        mesNumero: mesActual.mesNumero,
        mesNombre: mesActual.mesNombre,
        servicios: serviciosConEstado,
        totalDispositivos: totalMes
      });
    });

    res.render('dashboard', { dashboardData });
  } catch (err) {
    console.error('Error al generar dashboard:', err);
    res.status(500).send('Error al generar el dashboard: ' + err.message);
  }
});

// NUEVA RUTA: Dashboard de Comparación Factura por Factura
app.get('/dashboard-comparacion', async (req, res) => {
  try {
    const pool = await sql.connect(dbconfig);
    const result = await pool.request().query(`
      SELECT 
          NumeroFactura,
          Cliente,
          FechaEmision,
          YEAR(FechaEmision) AS Anio,
          MONTH(FechaEmision) AS MesNumero,
          DATENAME(MONTH, FechaEmision) AS MesNombre,
          MontoTotal
      FROM Facturas
      WHERE FechaEmision IS NOT NULL
      ORDER BY FechaEmision;
    `);

    const mesesEspanol = {
      'January': 'Enero',
      'February': 'Febrero',
      'March': 'Marzo',
      'April': 'Abril',
      'May': 'Mayo',
      'June': 'Junio',
      'July': 'Julio',
      'August': 'Agosto',
      'September': 'Septiembre',
      'October': 'Octubre',
      'November': 'Noviembre',
      'December': 'Diciembre'
    };

    // Estructura: { "2025-07": { "Servicio X": { facturas: [...] } } }
    const serviciosPorMes = {};
    
    result.recordset.forEach(factura => {
      const anioMes = `${factura.Anio}-${String(factura.MesNumero).padStart(2, '0')}`;
      const mesNombre = mesesEspanol[factura.MesNombre] || factura.MesNombre;
      
      if (!serviciosPorMes[anioMes]) {
        serviciosPorMes[anioMes] = {
          anio: factura.Anio,
          mesNumero: factura.MesNumero,
          mesNombre: mesNombre,
          servicios: {}
        };
      }
      
      const clienteCompleto = factura.Cliente || '';
      const serviciosEncontrados = extraerServicios(clienteCompleto);
      
      serviciosEncontrados.forEach(servicio => {
        const nombreServicio = servicio.nombre;
        const cantidad = servicio.cantidad;
        
        if (!serviciosPorMes[anioMes].servicios[nombreServicio]) {
          serviciosPorMes[anioMes].servicios[nombreServicio] = {
            nombre: nombreServicio,
            facturas: []
          };
        }
        
        serviciosPorMes[anioMes].servicios[nombreServicio].facturas.push({
          numero: factura.NumeroFactura,
          fecha: factura.FechaEmision,
          cantidad: cantidad,
          montoTotal: parseFloat(factura.MontoTotal) || 0
        });
      });
    });

    // Convertir a array y procesar comparaciones
    const mesesOrdenados = Object.keys(serviciosPorMes).sort();
    const dashboardComparacion = [];
    
    mesesOrdenados.forEach((anioMes, index) => {
      const mesActual = serviciosPorMes[anioMes];
      const serviciosData = [];
      
      Object.values(mesActual.servicios).forEach(servicio => {
        let facturasComparacion = [];
        
        // Comparar con mes anterior
        if (index > 0) {
          const anioMesAnterior = mesesOrdenados[index - 1];
          const mesAnterior = serviciosPorMes[anioMesAnterior];
          
          if (mesAnterior.servicios[servicio.nombre]) {
            const facturasAnteriores = mesAnterior.servicios[servicio.nombre].facturas;
            
            // Comparar cada factura del mes actual con todas del mes anterior
            servicio.facturas.forEach(facturaActual => {
              facturasAnteriores.forEach(facturaAnterior => {
                const diferenciaCantidad = facturaActual.cantidad - facturaAnterior.cantidad;
                const diferenciaMonto = facturaActual.montoTotal - facturaAnterior.montoTotal;
                
                facturasComparacion.push({
                  facturaActual: facturaActual.numero,
                  fechaActual: facturaActual.fecha,
                  cantidadActual: facturaActual.cantidad,
                  montoActual: facturaActual.montoTotal,
                  facturaAnterior: facturaAnterior.numero,
                  fechaAnterior: facturaAnterior.fecha,
                  cantidadAnterior: facturaAnterior.cantidad,
                  montoAnterior: facturaAnterior.montoTotal,
                  diferenciaCantidad: diferenciaCantidad,
                  diferenciaMonto: diferenciaMonto,
                  porcentajeCambio: facturaAnterior.cantidad > 0 
                    ? ((diferenciaCantidad / facturaAnterior.cantidad) * 100).toFixed(2)
                    : 0
                });
              });
            });
          } else {
            // Servicio nuevo en este mes
            servicio.facturas.forEach(facturaActual => {
              facturasComparacion.push({
                facturaActual: facturaActual.numero,
                fechaActual: facturaActual.fecha,
                cantidadActual: facturaActual.cantidad,
                montoActual: facturaActual.montoTotal,
                facturaAnterior: null,
                fechaAnterior: null,
                cantidadAnterior: 0,
                montoAnterior: 0,
                diferenciaCantidad: facturaActual.cantidad,
                diferenciaMonto: facturaActual.montoTotal,
                porcentajeCambio: 100,
                esNuevo: true
              });
            });
          }
        } else {
          // Primer mes, no hay comparación
          servicio.facturas.forEach(facturaActual => {
            facturasComparacion.push({
              facturaActual: facturaActual.numero,
              fechaActual: facturaActual.fecha,
              cantidadActual: facturaActual.cantidad,
              montoActual: facturaActual.montoTotal,
              facturaAnterior: null,
              fechaAnterior: null,
              cantidadAnterior: 0,
              montoAnterior: 0,
              diferenciaCantidad: 0,
              diferenciaMonto: 0,
              porcentajeCambio: 0,
              primerMes: true
            });
          });
        }
        
        serviciosData.push({
          nombreServicio: servicio.nombre,
          comparaciones: facturasComparacion,
          totalDispositivosActual: servicio.facturas.reduce((sum, f) => sum + f.cantidad, 0),
          totalMontoActual: servicio.facturas.reduce((sum, f) => sum + f.montoTotal, 0)
        });
      });
      
      dashboardComparacion.push({
        anioMes: anioMes,
        anio: mesActual.anio,
        mesNumero: mesActual.mesNumero,
        mesNombre: mesActual.mesNombre,
        servicios: serviciosData
      });
    });

    res.render('dashboard-comparacion', { dashboardComparacion });
  } catch (err) {
    console.error('Error al generar dashboard de comparación:', err);
    res.status(500).send('Error al generar el dashboard: ' + err.message);
  }
});

app.get('/extraerfacturapdf', async (req, res) => {
  try {
    const poolInstance = await getPool();
    const result = await poolInstance.request().query('SELECT * FROM Facturas');
    
    // Formatear los montos para mostrar
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
    } else if (texto.includes('Global AVL') || texto.includes('Hiber Data Stream')) {
      // FORMATO_GLOBAL_AVL
      tipoPDF = 'FORMATO_GLOBAL_AVL';
      
      // Extraer número de factura
      const facturaMatch = texto.match(/Factura\s+(GAVL[\dP\-]+)/i);
      numeroFactura = facturaMatch ? facturaMatch[1] : 'No encontrado';
      
      // Extraer fecha de emisión
      const fechaMatch = texto.match(/Fecha:\s*(\d{4})\/(\d{2})\/(\d{2})/);
      if (fechaMatch) {
        const [_, anio, mes, dia] = fechaMatch;
        fechaEmision = `${anio}-${mes}-${dia}`;
      }
      
      // No hay fecha de vencimiento explícita
      fechaVencimiento = null;
      
      // Extraer información del cliente
      const clienteMatch = texto.match(/Cliente:\s*([\s\S]*?)(?=RUT:|Enviar a:)/i);
      let infoCliente = '';
      if (clienteMatch) {
        infoCliente = clienteMatch[1]
          .replace(/\n+/g, ' ')
          .replace(/\s{2,}/g, ' ')
          .trim();
      }
      
      // Extraer servicios con cantidad > 0
      let descripcionServicios = '';
      const lineas = texto.split('\n');
      
      for (let linea of lineas) {
        linea = linea.trim();
        // Buscar líneas como: "1Servicio de localizacion 1 a 5,000 dispositivos9712,50 $2.427,50 $"
        if (/^\d+Servicio de localizacion/.test(linea)) {
          // Extraer número del item, descripción y cantidad
          const partes = linea.match(/^(\d+)(Servicio de localizacion[^0-9]+?)(\d+)/);
          if (partes) {
            const cantidad = parseInt(partes[3]);
            if (cantidad > 0) {
              const desc = partes[2].trim();
              descripcionServicios += desc + ' (' + cantidad + ' disp.); ';
            }
          }
        }
      }
      
      // Combinar cliente y servicios
      cliente = infoCliente;
      if (descripcionServicios) {
        cliente += ' - ' + descripcionServicios.slice(0, -2); // Quitar último "; "
      }
      
      // Extraer monto total - buscar todas las líneas con "Total" y tomar la última que no sea "Sub-Total" ni "Total de"
      let totalEncontrado = null;
      
      for (let linea of lineas) {
        linea = linea.trim();
        // Si la línea empieza con "Total" (no "Sub-Total" ni "Total de")
        if (linea.startsWith('Total') && !linea.startsWith('Sub-Total') && !linea.startsWith('Total de')) {
          // Extraer el número que viene después de "Total"
          const match = linea.match(/Total\s*([\d.,]+)/);
          if (match) {
            totalEncontrado = match[1];
            console.log(`✓ Total encontrado: línea="${linea}", valor="${totalEncontrado}"`);
          }
        }
      }
      
      if (totalEncontrado) {
        montoTotal = totalEncontrado;
      }
      
      console.log('Formato Global AVL detectado:', {
        numeroFactura,
        fechaEmision,
        cliente: cliente.substring(0, 150) + (cliente.length > 150 ? '...' : ''),
        montoTotal: montoTotal,
        montoLimpio: limpiarNumero(montoTotal)
      });
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
      cliente: cliente.substring(0, 100),
      montoTotal,
      montoLimpio: limpiarNumero(montoTotal)
    });

    const poolInstance = await getPool();
    const montoFinal = limpiarNumero(montoTotal);
    
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
    
    console.log('✓ Factura guardada exitosamente');

    res.redirect('/extraerfacturapdf');
  } catch (error) {
    console.error('Error al procesar la factura:', error);
    res.status(500).send('Error al procesar la factura: ' + error.message + '<br>' + error.stack);
  }
});

// RUTA DE DIAGNÓSTICO - Agrega esta ruta TEMPORAL para ver qué hay en tus facturas
app.get('/debug-facturas', async (req, res) => {
  try {
    const pool = await sql.connect(dbconfig);
    const result = await pool.request().query(`
      SELECT 
          NumeroFactura,
          Cliente,
          FechaEmision,
          MontoTotal
      FROM Facturas
      ORDER BY FechaEmision;
    `);

    let html = '<h1>DEBUG: Contenido de Facturas</h1>';
    html += '<style>body{font-family:monospace;padding:20px} .factura{border:2px solid #333;margin:20px 0;padding:15px;background:#f5f5f5} .campo{margin:10px 0;padding:10px;background:white}</style>';
    
    if (result.recordset.length === 0) {
      html += '<p style="color:red;font-size:20px">⚠️ NO HAY FACTURAS EN LA BASE DE DATOS</p>';
    } else {
      result.recordset.forEach(factura => {
        html += '<div class="factura">';
        html += `<h2>Factura: ${factura.NumeroFactura}</h2>`;
        html += `<div class="campo"><strong>Fecha:</strong> ${factura.FechaEmision}</div>`;
        html += `<div class="campo"><strong>Monto:</strong> ${factura.MontoTotal}</div>`;
        html += `<div class="campo"><strong>Campo Cliente (donde buscan servicios):</strong><br><pre>${factura.Cliente}</pre></div>`;
        
        // Probar la nueva función de extracción
        const serviciosEncontrados = extraerServicios(factura.Cliente);
        
        if (serviciosEncontrados.length > 0) {
          html += '<div class="campo" style="background:#d4edda"><strong>✓ Servicios encontrados:</strong><br>';
          serviciosEncontrados.forEach(servicio => {
            html += `- ${servicio.nombre}: ${servicio.cantidad} unidades<br>`;
          });
          html += '</div>';
        } else {
          html += '<div class="campo" style="background:#f8d7da"><strong>✗ NO se encontraron servicios</strong></div>';
        }
        
        html += '</div>';
      });
    }
    
    html += '<br><br><a href="/dashboard-comparacion" style="padding:10px 20px;background:#007bff;color:white;text-decoration:none;border-radius:5px">Ver Dashboard de Comparación</a>';
    html += ' <a href="/dashboard" style="padding:10px 20px;background:#28a745;color:white;text-decoration:none;border-radius:5px;margin-left:10px">Ver Dashboard por Mes</a>';
    
    res.send(html);
  } catch (err) {
    res.status(500).send('Error: ' + err.message);
  }
});

iniciarServidor();