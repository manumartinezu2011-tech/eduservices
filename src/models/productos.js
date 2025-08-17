const pool = require('../controllers/db'); // Asegúrate de que la ruta sea correcta

exports.getAllProductos = async (orden = 'id', direccion = 'DESC') => {
  // Modificado para usar parámetros de PostgreSQL y sintaxis adecuada para ORDER BY
  const query = `SELECT * FROM pedidos ORDER BY id desc`;
  const { rows } = await pool.query(query);
  return rows;
};

exports.deleteProducto = async (id) => {
  await pool.query('DELETE FROM pedidos WHERE id = $1', [id]);
};

exports.updateProducto = async (id, producto, precio, cantidad, comentario, nuevo_precio, porcentaje) => {
  // Validar campos permitidos para evitar SQL Injection
  const camposPermitidos = ['producto', 'precio', 'cantidad', 'comentario', 'fecha', 'nuevo_precio', 'porcentaje'];
  const updates = [];
  const values = [];
  let paramIndex = 1;

  if (camposPermitidos.includes('producto')) {
    updates.push(`producto = $${paramIndex++}`);
    values.push(producto);
  }
  if (camposPermitidos.includes('precio')) {
    updates.push(`precio = $${paramIndex++}`);
    values.push(precio);
  }
  if (camposPermitidos.includes('cantidad')) {
    updates.push(`cantidad = $${paramIndex++}`);
    values.push(cantidad);
  }
  if (camposPermitidos.includes('comentario')) {
    updates.push(`comentario = $${paramIndex++}`);
    values.push(comentario);
  }
  if (camposPermitidos.includes('fecha')) {
    updates.push(`fecha = $${paramIndex++}`);
    values.push(new Date());
  }
  if (camposPermitidos.includes('nuevo_precio')) {
    updates.push(`nuevo_precio = $${paramIndex++}`);
    values.push(nuevo_precio);
  }
  if (camposPermitidos.includes('porcentaje')) {
    updates.push(`porcentaje = $${paramIndex++}`);
    values.push(porcentaje);
  }

  values.push(id);
  
  const query = `UPDATE pedidos SET ${updates.join(', ')} WHERE id = $${paramIndex}`;
  await pool.query(query, values);
}

exports.insertarPedido = async (producto, precio, cantidad, comentario, nuevo_precio, porcentaje) => {
  try {
    const { rows } = await pool.query(
      'INSERT INTO pedidos (producto, precio, cantidad, comentario, fecha, nuevo_precio, porcentaje, estado) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id',
      [producto, precio, cantidad, comentario, new Date(), nuevo_precio, porcentaje, false]
    );  
    return { success: true, id: rows[0].id };
  } catch (error) {
    console.error('Error al insertar el pedido:', error);
    throw new Error('Error al insertar el pedido');
  }
}

exports.updateEstadoProducto = async (id, estado) => {
  const query = 'UPDATE pedidos SET estado = $1 WHERE id = $2';
  await pool.query(query, [estado, id]);
}