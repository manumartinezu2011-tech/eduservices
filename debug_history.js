
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
    user: process.env.DB_USER || 'postgres',
    host: process.env.DB_HOST || 'localhost',
    database: process.env.DB_NAME || 'freshfruit_erp',
    password: process.env.DB_PASSWORD || 'password',
    port: process.env.DB_PORT || 5432,
});

async function checkHistory() {
    try {
        console.log('Checking register_closures table...');
        const res = await pool.query(`
      SELECT rc.id, rc.closing_date, rc.user_id, u.full_name, u.username 
      FROM register_closures rc 
      LEFT JOIN users u ON rc.user_id = u.id 
      ORDER BY rc.closing_date DESC 
      LIMIT 5
    `);

        console.log('Top 5 Closures:');
        res.rows.forEach(row => {
            console.log(JSON.stringify(row));
        });
    } catch (err) {
        console.error('Error executing query', err);
    } finally {
        await pool.end();
    }
}

checkHistory();
