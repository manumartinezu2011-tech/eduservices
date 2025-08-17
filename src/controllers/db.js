const { Pool } = require('pg');
const dotenv = require('dotenv');
dotenv.config();

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT || 5432,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  max: 10, // Número máximo de clientes en el pool (equivalente a connectionLimit)
  idleTimeoutMillis: 30000, // Tiempo en ms que un cliente puede estar inactivo
  connectionTimeoutMillis: 2000 // Tiempo para obtener nueva conexión
});

// Manejo de errores para el pool
pool.on('error', (err) => {
  console.error('Error inesperado en el pool de PostgreSQL', err);
  process.exit(-1);
});

module.exports = pool;