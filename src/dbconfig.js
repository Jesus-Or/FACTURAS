const mssql = require('mssql');

const config ={
    user: 'pruebasNode',
    password: 'Oct4br30192',
    server:'DESKTOP-93DS6HF',
    database: 'facturas',
    options: {
    encrypt: false, // usa true si tienes SSL
    trustServerCertificate: true
  }
};

module.exports = config;