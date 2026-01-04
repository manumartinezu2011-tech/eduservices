const { Pool } = require('pg')
require('dotenv').config()

const pool = new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 5432,
    database: process.env.DB_NAME || 'freshfruit_erp',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD
})

async function check() {
    const client = await pool.connect()
    try {
        const res = await client.query(`
            SELECT column_name, data_type 
            FROM information_schema.columns 
            WHERE table_name = 'users' AND column_name = 'id'
        `)
        console.log('User ID Type:', res.rows[0])
    } catch (e) {
        console.error(e)
    } finally {
        client.release()
        pool.end()
    }
}
check()
