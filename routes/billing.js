const express = require('express')
const router = express.Router()
const { Pool } = require('pg')

const pool = new Pool({
  user: process.env.DB_USER || 'postgres',
  host: process.env.DB_HOST || 'localhost',
  database: process.env.DB_NAME || 'freshfruit_erp',
  password: process.env.DB_PASSWORD || 'password',
  port: process.env.DB_PORT || 5432,
})

// GET /api/billing/invoices - Get all invoices with filtering
router.get('/invoices', async (req, res) => {
  try {
    const { status, customer, date_from, date_to, search, page = 1, limit = 50 } = req.query

    let query = `
      SELECT 
        i.*,
        c.name as customer_name,
        c.email as customer_email,
        COALESCE(
          JSON_AGG(
            JSON_BUILD_OBJECT(
              'id', ii.id,
              'product_id', ii.product_id,
              'product_name', p.name,
              'quantity', ii.quantity,
              'unit_price', ii.unit_price,
              'total', ii.total_price
            )
          ) FILTER (WHERE ii.id IS NOT NULL),
          '[]'::json
        ) as items
      FROM invoices i
      LEFT JOIN customers c ON i.customer_id = c.id
      LEFT JOIN invoice_items ii ON i.id = ii.invoice_id
      LEFT JOIN products p ON ii.product_id = p.id
      WHERE 1=1
    `

    const queryParams = []
    let paramIndex = 1

    if (status) {
      query += ` AND i.status = $${paramIndex}`
      queryParams.push(status)
      paramIndex++
    }

    if (customer) {
      query += ` AND i.customer_id = $${paramIndex}`
      queryParams.push(customer)
      paramIndex++
    }

    if (date_from) {
      query += ` AND i.invoice_date >= $${paramIndex}`
      queryParams.push(date_from)
      paramIndex++
    }

    if (date_to) {
      query += ` AND i.invoice_date <= $${paramIndex}`
      queryParams.push(date_to)
      paramIndex++
    }

    if (search) {
      query += ` AND (i.invoice_number ILIKE $${paramIndex} OR c.name ILIKE $${paramIndex})`
      queryParams.push(`%${search}%`)
      paramIndex++
    }

    query += `
      GROUP BY i.id, c.name, c.email
      ORDER BY i.created_at DESC
      LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
    `

    queryParams.push(limit, (page - 1) * limit)

    const result = await pool.query(query, queryParams)

    // Get total count for pagination
    let countQuery = `
      SELECT COUNT(DISTINCT i.id) as total
      FROM invoices i
      LEFT JOIN customers c ON i.customer_id = c.id
      WHERE 1=1
    `

    let countParams = []
    let countParamIndex = 1

    if (status) {
      countQuery += ` AND i.status = $${countParamIndex}`
      countParams.push(status)
      countParamIndex++
    }

    if (customer) {
      countQuery += ` AND i.customer_id = $${countParamIndex}`
      countParams.push(customer)
      countParamIndex++
    }

    if (date_from) {
      countQuery += ` AND i.invoice_date >= $${countParamIndex}`
      countParams.push(date_from)
      countParamIndex++
    }

    if (date_to) {
      countQuery += ` AND i.invoice_date <= $${countParamIndex}`
      countParams.push(date_to)
      countParamIndex++
    }

    if (search) {
      countQuery += ` AND (i.invoice_number ILIKE $${countParamIndex} OR c.name ILIKE $${countParamIndex})`
      countParams.push(`%${search}%`)
      countParamIndex++
    }

    const countResult = await pool.query(countQuery, countParams)
    const total = parseInt(countResult.rows[0].total)

    res.json({
      invoices: result.rows,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      }
    })
  } catch (error) {
    console.error('Error fetching invoices:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/billing/invoices/:id - Get specific invoice
router.get('/invoices/:id', async (req, res) => {
  try {
    const { id } = req.params

    const query = `
      SELECT 
        i.*,
        c.name as customer_name,
        c.email as customer_email,
        c.phone as customer_phone,
        c.address as customer_address,
        COALESCE(
          JSON_AGG(
            JSON_BUILD_OBJECT(
              'id', ii.id,
              'product_id', ii.product_id,
              'product_name', p.name,
              'quantity', ii.quantity,
              'unit_price', ii.unit_price,
              'total', ii.total_price
            )
          ) FILTER (WHERE ii.id IS NOT NULL),
          '[]'::json
        ) as items
      FROM invoices i
      LEFT JOIN customers c ON i.customer_id = c.id
      LEFT JOIN invoice_items ii ON i.id = ii.invoice_id
      LEFT JOIN products p ON ii.product_id = p.id
      WHERE i.id = $1
      GROUP BY i.id, c.name, c.email, c.phone, c.address
    `

    const result = await pool.query(query, [id])

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Invoice not found' })
    }

    res.json(result.rows[0])
  } catch (error) {
    console.error('Error fetching invoice:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/billing/invoices - Create new invoice
router.post('/invoices', async (req, res) => {
  const client = await pool.connect()

  try {
    await client.query('BEGIN')

    const {
      customer_id,
      invoice_number,
      invoice_date,
      due_date,
      subtotal,
      tax_amount,
      total,
      discount_amount,
      paid_amount,
      notes,
      order_id,
      status = 'pending',
      items
    } = req.body

    // Validate required fields
    if (!customer_id || !invoice_number || !invoice_date || !due_date || !total) {
      return res.status(400).json({ error: 'Missing required fields' })
    }

    // Check if invoice number already exists
    const existingInvoice = await client.query(
      'SELECT id FROM invoices WHERE invoice_number = $1',
      [invoice_number]
    )

    if (existingInvoice.rows.length > 0) {
      return res.status(400).json({ error: 'Invoice number already exists' })
    }

    // Create invoice
    const invoiceQuery = `
      INSERT INTO invoices
      (customer_id, invoice_number, invoice_date, due_date, subtotal, tax_amount, total, discount_amount, paid_amount, notes, order_id, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      RETURNING *
    `

    const invoiceResult = await client.query(invoiceQuery, [
      customer_id, invoice_number, invoice_date, due_date,
      subtotal || 0, tax_amount || 0, total, discount_amount || 0, paid_amount || 0, notes, order_id, status
    ])

    const invoice = invoiceResult.rows[0]

    // Create invoice items if provided
    if (items && items.length > 0) {
      for (const item of items) {
        const itemQuery = `
          INSERT INTO invoice_items (invoice_id, product_id, product_name, quantity, unit_price)
          VALUES ($1, $2, $3, $4, $5)
        `
        await client.query(itemQuery, [
          invoice.id,
          item.product_id,
          item.product_name || 'Unknown Product',
          item.quantity,
          item.unit_price
        ])
      }
    }

    await client.query('COMMIT')

    // Fetch complete invoice with items
    const completeInvoiceQuery = `
      SELECT 
        i.*,
        c.name as customer_name,
        c.email as customer_email,
        COALESCE(
          JSON_AGG(
            JSON_BUILD_OBJECT(
              'id', ii.id,
              'product_id', ii.product_id,
              'product_name', p.name,
              'quantity', ii.quantity,
              'unit_price', ii.unit_price,
              'total', ii.total_price
            )
          ) FILTER (WHERE ii.id IS NOT NULL),
          '[]'::json
        ) as items
      FROM invoices i
      LEFT JOIN customers c ON i.customer_id = c.id
      LEFT JOIN invoice_items ii ON i.id = ii.invoice_id
      LEFT JOIN products p ON ii.product_id = p.id
      WHERE i.id = $1
      GROUP BY i.id, c.name, c.email
    `

    const completeResult = await client.query(completeInvoiceQuery, [invoice.id])

    res.status(201).json(completeResult.rows[0])
  } catch (error) {
    await client.query('ROLLBACK')
    console.error('Error creating invoice:', error)
    res.status(500).json({ error: 'Internal server error' })
  } finally {
    client.release()
  }
})

// PUT /api/billing/invoices/:id - Update invoice
router.put('/invoices/:id', async (req, res) => {
  const client = await pool.connect()

  try {
    await client.query('BEGIN')

    const { id } = req.params
    const {
      customer_id,
      invoice_number,
      invoice_date,
      due_date,
      status,
      order_id,
      discount_amount,
      paid_amount,
      notes,
      items,
      subtotal,
      tax_amount,
      total,
      total_amount
    } = req.body

    // Handle both total and total_amount parameter names
    const finalTotal = total || total_amount

    // Check if invoice exists
    const existingInvoice = await client.query('SELECT * FROM invoices WHERE id = $1', [id])
    if (existingInvoice.rows.length === 0) {
      return res.status(404).json({ error: 'Invoice not found' })
    }

    // Update invoice
    const updateQuery = `
      UPDATE invoices
      SET customer_id = $2, invoice_number = $3, invoice_date = $4, due_date = $5,
          status = $6, order_id = $7, discount_amount = $8, paid_amount = $9, notes = $10,
          subtotal = $11, tax_amount = $12, total = $13,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING *
    `

    await client.query(updateQuery, [
      id,
      customer_id,
      invoice_number,
      invoice_date,
      due_date,
      status,
      order_id,
      discount_amount || 0,
      paid_amount || 0,
      notes,
      subtotal || 0,
      tax_amount || 0,
      finalTotal || 0
    ])

    // Update invoice items
    if (items && items.length > 0) {
      // Delete existing items
      await client.query('DELETE FROM invoice_items WHERE invoice_id = $1', [id])

      // Insert updated items
      for (const item of items) {
        let productName = item.product_name || 'Unknown Product'

        // If product_name is not provided, fetch it from products table
        if (!item.product_name && item.product_id) {
          try {
            const productResult = await client.query('SELECT name FROM products WHERE id = $1', [item.product_id])
            if (productResult.rows.length > 0) {
              productName = productResult.rows[0].name
            }
          } catch (err) {
            console.log('Could not fetch product name:', err.message)
          }
        }

        const itemQuery = `
          INSERT INTO invoice_items (invoice_id, product_id, product_name, quantity, unit_price)
          VALUES ($1, $2, $3, $4, $5)
        `
        await client.query(itemQuery, [
          id,
          item.product_id,
          productName,
          item.quantity,
          item.unit_price
        ])
      }
    }

    await client.query('COMMIT')

    // Fetch updated invoice with items
    const completeInvoiceQuery = `
      SELECT 
        i.*,
        c.name as customer_name,
        c.email as customer_email,
        COALESCE(
          JSON_AGG(
            JSON_BUILD_OBJECT(
              'id', ii.id,
              'product_id', ii.product_id,
              'product_name', p.name,
              'quantity', ii.quantity,
              'unit_price', ii.unit_price,
              'total', ii.total_price
            )
          ) FILTER (WHERE ii.id IS NOT NULL),
          '[]'::json
        ) as items
      FROM invoices i
      LEFT JOIN customers c ON i.customer_id = c.id
      LEFT JOIN invoice_items ii ON i.id = ii.invoice_id
      LEFT JOIN products p ON ii.product_id = p.id
      WHERE i.id = $1
      GROUP BY i.id, c.name, c.email
    `

    const result = await client.query(completeInvoiceQuery, [id])
    res.json(result.rows[0])
  } catch (error) {
    await client.query('ROLLBACK')
    console.error('Error updating invoice:', error)
    res.status(500).json({ error: 'Internal server error' })
  } finally {
    client.release()
  }
})

// PATCH /api/billing/invoices/:id/status - Update invoice status
router.patch('/invoices/:id/status', async (req, res) => {
  try {
    const { id } = req.params
    const { status } = req.body

    const validStatuses = ['pending', 'paid', 'overdue', 'cancelled']
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid status' })
    }

    const query = `
      UPDATE invoices 
      SET status = $2, updated_at = CURRENT_TIMESTAMP
      WHERE id = $1
      RETURNING *
    `

    const result = await pool.query(query, [id, status])

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Invoice not found' })
    }

    res.json(result.rows[0])
  } catch (error) {
    console.error('Error updating invoice status:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// DELETE /api/billing/invoices/:id - Delete invoice
router.delete('/invoices/:id', async (req, res) => {
  const client = await pool.connect()

  try {
    await client.query('BEGIN')

    const { id } = req.params

    // Delete invoice items first (foreign key constraint)
    await client.query('DELETE FROM invoice_items WHERE invoice_id = $1', [id])

    // Delete invoice
    const result = await client.query('DELETE FROM invoices WHERE id = $1 RETURNING *', [id])

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Invoice not found' })
    }

    await client.query('COMMIT')
    res.json({ message: 'Invoice deleted successfully' })
  } catch (error) {
    await client.query('ROLLBACK')
    console.error('Error deleting invoice:', error)
    res.status(500).json({ error: 'Internal server error' })
  } finally {
    client.release()
  }
})

// GET /api/billing/summary - Get billing summary/stats
router.get('/summary', async (req, res) => {
  try {
    const summaryQuery = `
      SELECT
        COUNT(*) FILTER (WHERE status = 'paid') as paid_invoices,
        COUNT(*) FILTER (WHERE status = 'pending') as pending_invoices,
        COUNT(*) FILTER (WHERE status = 'overdue') as overdue_invoices,
        COUNT(*) as total_invoices,
        COALESCE(SUM(total) FILTER (WHERE status = 'paid'), 0) as paid_amount,
        COALESCE(SUM(total) FILTER (WHERE status = 'pending'), 0) as pending_amount,
        COALESCE(SUM(total) FILTER (WHERE status = 'overdue'), 0) as overdue_amount,
        COALESCE(SUM(total), 0) as total_billed
      FROM invoices
      WHERE created_at >= CURRENT_DATE - INTERVAL '1 year'
    `

    const result = await pool.query(summaryQuery)
    const summary = result.rows[0]

    // Convert string numbers to integers/floats
    res.json({
      paid_invoices: parseInt(summary.paid_invoices) || 0,
      pending_invoices: parseInt(summary.pending_invoices) || 0,
      overdue_invoices: parseInt(summary.overdue_invoices) || 0,
      total_invoices: parseInt(summary.total_invoices) || 0,
      paid_amount: parseFloat(summary.paid_amount) || 0,
      pending_amount: parseFloat(summary.pending_amount) || 0,
      overdue_amount: parseFloat(summary.overdue_amount) || 0,
      total_billed: parseFloat(summary.total_billed) || 0
    })
  } catch (error) {
    console.error('Error fetching billing summary:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/billing/next-invoice-number - Get next available invoice number
router.get('/next-invoice-number', async (req, res) => {
  try {
    const query = `
      SELECT invoice_number 
      FROM invoices 
      WHERE invoice_number ~ '^FAC-[0-9]+$'
      ORDER BY CAST(SUBSTRING(invoice_number FROM 5) AS INTEGER) DESC 
      LIMIT 1
    `

    const result = await pool.query(query)

    let nextNumber = 'FAC-001'
    if (result.rows.length > 0) {
      const lastNumber = result.rows[0].invoice_number
      const numberPart = parseInt(lastNumber.split('-')[1])
      nextNumber = `FAC-${String(numberPart + 1).padStart(3, '0')}`
    }

    res.json({ next_invoice_number: nextNumber })
  } catch (error) {
    console.error('Error getting next invoice number:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})


// Temporary endpoint to modify sales_order_id field type
router.post('/modify-sales-order-id', async (req, res) => {
  const client = await pool.connect()

  try {
    console.log('Modifying sales_order_id field type...')

    // Drop the foreign key constraint first
    await client.query(`
      ALTER TABLE invoices 
      DROP CONSTRAINT IF EXISTS invoices_sales_order_id_fkey
    `)

    // Change the column type from UUID to VARCHAR
    await client.query(`
      ALTER TABLE invoices 
      ALTER COLUMN sales_order_id TYPE VARCHAR(50)
    `)

    console.log('sales_order_id field modified successfully')
    res.json({ message: 'sales_order_id field modified successfully' })
  } catch (error) {
    console.error('Error modifying sales_order_id field:', error)
    res.status(500).json({ error: error.message })
  } finally {
    client.release()
  }
})

// Temporary endpoint to modify order_id field type
router.post('/modify-order-id', async (req, res) => {
  const client = await pool.connect()

  try {
    console.log('Modifying order_id field type...')

    // Drop the foreign key constraint first (if any)
    await client.query(`
      ALTER TABLE invoices
      DROP CONSTRAINT IF EXISTS invoices_order_id_fkey
    `)

    // Change the column type from UUID to VARCHAR
    await client.query(`
      ALTER TABLE invoices
      ALTER COLUMN order_id TYPE VARCHAR(50)
    `)

    console.log('order_id field modified successfully')
    res.json({ message: 'order_id field modified successfully' })
  } catch (error) {
    console.error('Error modifying order_id field:', error)
    res.status(500).json({ error: error.message })
  } finally {
    client.release()
  }
})

// Temporary endpoint to create invoice_items table
router.post('/setup-invoice-items', async (req, res) => {
  const client = await pool.connect()

  try {
    console.log('Creating invoice_items table...')

    // Create the table
    await client.query(`
      CREATE TABLE IF NOT EXISTS invoice_items (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          invoice_id UUID REFERENCES invoices(id) ON DELETE CASCADE,
          product_id UUID REFERENCES products(id),
          product_name VARCHAR(255) NOT NULL,
          quantity INTEGER NOT NULL CHECK (quantity > 0),
          unit_price DECIMAL(10,2) NOT NULL CHECK (unit_price >= 0),
          total_price DECIMAL(10,2) GENERATED ALWAYS AS (quantity * unit_price) STORED,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `)

    // Create indexes
    await client.query(`CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice ON invoice_items(invoice_id)`)
    await client.query(`CREATE INDEX IF NOT EXISTS idx_invoice_items_product ON invoice_items(product_id)`)

    // Create trigger - PostgreSQL doesn't support IF NOT EXISTS for triggers
    try {
      await client.query(`
        CREATE TRIGGER update_invoice_items_updated_at 
            BEFORE UPDATE ON invoice_items 
            FOR EACH ROW 
            EXECUTE FUNCTION update_updated_at_column()
      `)
    } catch (triggerError) {
      // Trigger might already exist, that's ok
      console.log('Trigger may already exist:', triggerError.message)
    }

    console.log('invoice_items table created successfully')
    res.json({ message: 'invoice_items table created successfully' })
  } catch (error) {
    console.error('Error creating invoice_items table:', error)
    res.status(500).json({ error: error.message })
  } finally {
    client.release()
  }
})

module.exports = router