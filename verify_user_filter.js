const { Pool } = require('pg');
require('dotenv').config();

const API_URL = 'http://localhost:3001/api';

const pool = new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 5432,
    database: process.env.DB_NAME || 'freshfruit_erp',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD
});

async function runVerification() {
    const client = await pool.connect();
    try {
        console.log('Starting verification...');

        // 1. Get necessary IDs
        const userRes = await client.query('SELECT id FROM users LIMIT 1');
        const customerRes = await client.query('SELECT id FROM customers LIMIT 1');
        const productRes = await client.query('SELECT id, price FROM products WHERE stock > 10 LIMIT 1');

        if (!userRes.rows.length || !customerRes.rows.length || !productRes.rows.length) {
            throw new Error('Missing required data (users, customers, or products)');
        }

        const userId = userRes.rows[0].id;
        const customerId = customerRes.rows[0].id;
        const product = productRes.rows[0];

        console.log(`Using User ID: ${userId}`);

        // 2. Create a test order
        const orderNumber = `TEST-${Date.now()}`;
        const insertOrderQuery = `
            INSERT INTO orders (customer_id, order_number, subtotal, total, user_id, status)
            VALUES ($1, $2, $3, $4, $5, 'completed')
            RETURNING id
        `;
        await client.query(insertOrderQuery, [customerId, orderNumber, product.price, product.price, userId]);
        console.log(`Created test order ${orderNumber} directly in DB`);

        // 3. Test GET /api/orders with filter
        console.log('Testing GET /api/orders with user_id filter...');
        const ordersRes = await fetch(`${API_URL}/orders?user_id=${userId}`);
        const ordersData = await ordersRes.json();

        const foundOrder = ordersData.data.find(o => o.order_number === orderNumber);
        if (foundOrder) {
            console.log('✅ Found test order in filtered list');
        } else {
            console.error('❌ Test order NOT found in filtered list');
            console.log('Orders returned:', ordersData.data.map(o => o.order_number));
        }

        // 4. Test GET /api/orders/stats/summary with filter
        console.log('Testing GET /api/orders/stats/summary with user_id filter...');
        const statsRes = await fetch(`${API_URL}/orders/stats/summary?user_id=${userId}`);
        const statsData = await statsRes.json();

        console.log('Stats returned:', JSON.stringify(statsData, null, 2));
        if (statsData.data && statsData.data.total_orders > 0) {
            console.log('✅ Stats return non-zero orders for this user');
        } else {
            console.log('⚠️ Stats return 0 orders (might be correct if this is the first order, but we just created one)');
        }

    } catch (error) {
        console.error('Verification failed:', error.message);
    } finally {
        client.release();
        pool.end();
    }
}

runVerification();
