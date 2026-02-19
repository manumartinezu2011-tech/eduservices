
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
    user: process.env.DB_USER || 'postgres',
    host: process.env.DB_HOST || 'localhost',
    database: process.env.DB_NAME || 'freshfruit_erp',
    password: process.env.DB_PASSWORD || 'password',
    port: process.env.DB_PORT || 5432,
});

async function checkUsers() {
    try {
        console.log('Checking users table...');
        const res = await pool.query('SELECT id, username, full_name, email FROM users');

        console.log('Users found:', res.rowCount);
        res.rows.forEach(row => {
            console.log(JSON.stringify(row));
        });
    } catch (err) {
        console.error('Error executing query', err);
    } finally {
        await pool.end();
    }
}

checkUsers();
