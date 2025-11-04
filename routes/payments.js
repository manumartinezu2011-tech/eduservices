const express = require('express');
const router = express.Router();
const { pool } = require('../config/database');

// Get all payments with optional filters
router.get('/', async (req, res) => {
  try {
    const { customer_id, order_id, status, start_date, end_date } = req.query;

    let query = `
      SELECT
        p.*,
        o.order_number,
        o.total as order_total,
        c.name as customer_name,
        u.full_name as processed_by
      FROM payments p
      LEFT JOIN orders o ON p.order_id = o.id
      LEFT JOIN customers c ON p.customer_id = c.id
      LEFT JOIN users u ON p.user_id = u.id
      WHERE 1=1
    `;

    const params = [];
    let paramCount = 1;

    if (customer_id) {
      query += ` AND p.customer_id = $${paramCount}`;
      params.push(customer_id);
      paramCount++;
    }

    if (order_id) {
      query += ` AND p.order_id = $${paramCount}`;
      params.push(order_id);
      paramCount++;
    }

    if (status) {
      query += ` AND p.status = $${paramCount}`;
      params.push(status);
      paramCount++;
    }

    if (start_date) {
      query += ` AND p.payment_date >= $${paramCount}`;
      params.push(start_date);
      paramCount++;
    }

    if (end_date) {
      query += ` AND p.payment_date <= $${paramCount}`;
      params.push(end_date);
      paramCount++;
    }

    query += ' ORDER BY p.payment_date DESC';

    const result = await pool.query(query, params);
    res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Error fetching payments:', error);
    res.status(500).json({ success: false, error: 'Internal server error', message: error.message });
  }
});

// Get payment by ID
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const query = `
      SELECT
        p.*,
        o.order_number,
        o.total as order_total,
        o.status as order_status,
        c.name as customer_name,
        c.email as customer_email,
        c.phone as customer_phone,
        u.full_name as processed_by
      FROM payments p
      LEFT JOIN orders o ON p.order_id = o.id
      LEFT JOIN customers c ON p.customer_id = c.id
      LEFT JOIN users u ON p.user_id = u.id
      WHERE p.id = $1
    `;

    const result = await pool.query(query, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Payment not found' });
    }

    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Error fetching payment:', error);
    res.status(500).json({ success: false, error: 'Internal server error', message: error.message });
  }
});

// Get payments summary for an order (total paid, balance remaining)
router.get('/order/:order_id/summary', async (req, res) => {
  try {
    const { order_id } = req.params;

    const query = `
      SELECT
        o.id as order_id,
        o.order_number,
        o.total as order_total,
        o.payment_status,
        COALESCE(SUM(p.amount) FILTER (WHERE p.status = 'completed'), 0) as total_paid,
        o.total - COALESCE(SUM(p.amount) FILTER (WHERE p.status = 'completed'), 0) as balance_remaining,
        COUNT(p.id) as payment_count
      FROM orders o
      LEFT JOIN payments p ON o.id = p.order_id
      WHERE o.id = $1
      GROUP BY o.id, o.order_number, o.total, o.payment_status
    `;

    const result = await pool.query(query, [order_id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Order not found' });
    }

    res.json({ success: true, data: result.rows[0] });
  } catch (error) {
    console.error('Error fetching payment summary:', error);
    res.status(500).json({ success: false, error: 'Internal server error', message: error.message });
  }
});

// Create new payment
router.post('/', async (req, res) => {
  const client = await pool.connect();

  try {
    const {
      order_id,
      customer_id,
      amount,
      payment_method,
      payment_date,
      reference_number,
      notes,
      user_id
    } = req.body;

    // Validate required fields
    if (!order_id || !amount || !payment_method) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: order_id, amount, and payment_method are required'
      });
    }

    // Validate amount is positive
    if (parseFloat(amount) <= 0) {
      return res.status(400).json({
        success: false,
        error: 'Payment amount must be greater than 0'
      });
    }

    await client.query('BEGIN');

    // Get order details
    const orderQuery = 'SELECT id, total, customer_id FROM orders WHERE id = $1';
    const orderResult = await client.query(orderQuery, [order_id]);

    if (orderResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, error: 'Order not found' });
    }

    const order = orderResult.rows[0];
    const finalCustomerId = customer_id || order.customer_id;

    // Calculate total paid so far
    const paidQuery = `
      SELECT COALESCE(SUM(amount), 0) as total_paid
      FROM payments
      WHERE order_id = $1 AND status = 'completed'
    `;
    const paidResult = await client.query(paidQuery, [order_id]);
    const totalPaid = parseFloat(paidResult.rows[0].total_paid);
    const newTotalPaid = totalPaid + parseFloat(amount);

    // Check if payment exceeds order total
    if (newTotalPaid > parseFloat(order.total)) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        success: false,
        error: `Payment amount exceeds order balance. Order total: ${order.total}, Already paid: ${totalPaid}, Balance: ${order.total - totalPaid}`
      });
    }

    // Generate payment number
    const paymentNumberResult = await client.query('SELECT generate_payment_number() as payment_number');
    const payment_number = paymentNumberResult.rows[0].payment_number;

    // Insert payment
    const insertQuery = `
      INSERT INTO payments (
        order_id, customer_id, payment_number, amount, payment_method,
        payment_date, reference_number, notes, user_id, status
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'completed')
      RETURNING *
    `;

    const values = [
      order_id,
      finalCustomerId,
      payment_number,
      amount,
      payment_method,
      payment_date || new Date(),
      reference_number,
      notes,
      user_id
    ];

    const result = await client.query(insertQuery, values);

    // Update order payment status
    let newPaymentStatus;
    if (newTotalPaid >= parseFloat(order.total)) {
      newPaymentStatus = 'paid';
    } else if (newTotalPaid > 0) {
      newPaymentStatus = 'partial';
    } else {
      newPaymentStatus = 'pending';
    }

    await client.query(
      'UPDATE orders SET payment_status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [newPaymentStatus, order_id]
    );

    await client.query('COMMIT');

    res.status(201).json({
      success: true,
      data: result.rows[0],
      message: 'Payment registered successfully',
      order_payment_status: newPaymentStatus,
      total_paid: newTotalPaid,
      balance_remaining: parseFloat(order.total) - newTotalPaid
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error creating payment:', error);
    res.status(500).json({ success: false, error: 'Internal server error', message: error.message });
  } finally {
    client.release();
  }
});

// Update payment
router.put('/:id', async (req, res) => {
  const client = await pool.connect();

  try {
    const { id } = req.params;
    const {
      amount,
      payment_method,
      payment_date,
      reference_number,
      notes,
      status
    } = req.body;

    await client.query('BEGIN');

    // Get current payment
    const currentPayment = await client.query('SELECT * FROM payments WHERE id = $1', [id]);

    if (currentPayment.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, error: 'Payment not found' });
    }

    const updates = [];
    const values = [];
    let paramCount = 1;

    if (amount !== undefined) {
      updates.push(`amount = $${paramCount}`);
      values.push(amount);
      paramCount++;
    }
    if (payment_method !== undefined) {
      updates.push(`payment_method = $${paramCount}`);
      values.push(payment_method);
      paramCount++;
    }
    if (payment_date !== undefined) {
      updates.push(`payment_date = $${paramCount}`);
      values.push(payment_date);
      paramCount++;
    }
    if (reference_number !== undefined) {
      updates.push(`reference_number = $${paramCount}`);
      values.push(reference_number);
      paramCount++;
    }
    if (notes !== undefined) {
      updates.push(`notes = $${paramCount}`);
      values.push(notes);
      paramCount++;
    }
    if (status !== undefined) {
      updates.push(`status = $${paramCount}`);
      values.push(status);
      paramCount++;
    }

    if (updates.length === 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, error: 'No fields to update' });
    }

    values.push(id);
    const query = `
      UPDATE payments
      SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP
      WHERE id = $${paramCount}
      RETURNING *
    `;

    const result = await client.query(query, values);

    // Recalculate order payment status
    const order_id = currentPayment.rows[0].order_id;
    const orderQuery = 'SELECT total FROM orders WHERE id = $1';
    const orderResult = await client.query(orderQuery, [order_id]);

    const paidQuery = `
      SELECT COALESCE(SUM(amount), 0) as total_paid
      FROM payments
      WHERE order_id = $1 AND status = 'completed'
    `;
    const paidResult = await client.query(paidQuery, [order_id]);
    const totalPaid = parseFloat(paidResult.rows[0].total_paid);
    const orderTotal = parseFloat(orderResult.rows[0].total);

    let newPaymentStatus;
    if (totalPaid >= orderTotal) {
      newPaymentStatus = 'paid';
    } else if (totalPaid > 0) {
      newPaymentStatus = 'partial';
    } else {
      newPaymentStatus = 'pending';
    }

    await client.query(
      'UPDATE orders SET payment_status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [newPaymentStatus, order_id]
    );

    await client.query('COMMIT');

    res.json({
      success: true,
      data: result.rows[0],
      message: 'Payment updated successfully'
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error updating payment:', error);
    res.status(500).json({ success: false, error: 'Internal server error', message: error.message });
  } finally {
    client.release();
  }
});

// Delete payment
router.delete('/:id', async (req, res) => {
  const client = await pool.connect();

  try {
    const { id } = req.params;

    await client.query('BEGIN');

    // Get payment details
    const paymentQuery = 'SELECT * FROM payments WHERE id = $1';
    const paymentResult = await client.query(paymentQuery, [id]);

    if (paymentResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ success: false, error: 'Payment not found' });
    }

    const payment = paymentResult.rows[0];

    // Delete payment
    await client.query('DELETE FROM payments WHERE id = $1', [id]);

    // Recalculate order payment status
    const orderQuery = 'SELECT total FROM orders WHERE id = $1';
    const orderResult = await client.query(orderQuery, [payment.order_id]);

    const paidQuery = `
      SELECT COALESCE(SUM(amount), 0) as total_paid
      FROM payments
      WHERE order_id = $1 AND status = 'completed'
    `;
    const paidResult = await client.query(paidQuery, [payment.order_id]);
    const totalPaid = parseFloat(paidResult.rows[0].total_paid);
    const orderTotal = parseFloat(orderResult.rows[0].total);

    let newPaymentStatus;
    if (totalPaid >= orderTotal) {
      newPaymentStatus = 'paid';
    } else if (totalPaid > 0) {
      newPaymentStatus = 'partial';
    } else {
      newPaymentStatus = 'pending';
    }

    await client.query(
      'UPDATE orders SET payment_status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [newPaymentStatus, payment.order_id]
    );

    await client.query('COMMIT');

    res.json({
      success: true,
      message: 'Payment deleted successfully'
    });

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error deleting payment:', error);
    res.status(500).json({ success: false, error: 'Internal server error', message: error.message });
  } finally {
    client.release();
  }
});

// Get payment statistics
router.get('/stats/summary', async (req, res) => {
  try {
    const { start_date, end_date } = req.query;

    let query = `
      SELECT
        COUNT(*) as total_payments,
        COALESCE(SUM(amount), 0) as total_amount,
        COALESCE(AVG(amount), 0) as average_payment,
        COUNT(DISTINCT customer_id) as unique_customers,
        COUNT(DISTINCT order_id) as orders_with_payments
      FROM payments
      WHERE status = 'completed'
    `;

    const params = [];
    let paramCount = 1;

    if (start_date) {
      query += ` AND payment_date >= $${paramCount}`;
      params.push(start_date);
      paramCount++;
    }

    if (end_date) {
      query += ` AND payment_date <= $${paramCount}`;
      params.push(end_date);
      paramCount++;
    }

    const result = await pool.query(query, params);

    // Get payment method breakdown
    let methodQuery = `
      SELECT
        payment_method,
        COUNT(*) as count,
        COALESCE(SUM(amount), 0) as total_amount
      FROM payments
      WHERE status = 'completed'
    `;

    if (start_date || end_date) {
      methodQuery += ' AND';
      const methodParams = [];
      let methodParamCount = 1;

      if (start_date) {
        methodQuery += ` payment_date >= $${methodParamCount}`;
        methodParams.push(start_date);
        methodParamCount++;

        if (end_date) {
          methodQuery += ' AND';
        }
      }

      if (end_date) {
        methodQuery += ` payment_date <= $${methodParamCount}`;
        methodParams.push(end_date);
      }

      methodQuery += ' GROUP BY payment_method ORDER BY total_amount DESC';
      const methodResult = await pool.query(methodQuery, methodParams);

      res.json({
        success: true,
        data: {
          ...result.rows[0],
          by_payment_method: methodResult.rows
        }
      });
    } else {
      methodQuery += ' GROUP BY payment_method ORDER BY total_amount DESC';
      const methodResult = await pool.query(methodQuery);

      res.json({
        success: true,
        data: {
          ...result.rows[0],
          by_payment_method: methodResult.rows
        }
      });
    }

  } catch (error) {
    console.error('Error fetching payment statistics:', error);
    res.status(500).json({ success: false, error: 'Internal server error', message: error.message });
  }
});

module.exports = router;
