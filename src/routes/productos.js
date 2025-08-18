const express = require('express');
const router = express.Router();
const productosController = require('../models/productos');

router.get('/', async (req, res) => {
  try {
    const { orden, direccion } = req.query;
    const productos = await productosController.getAllProductos(orden, direccion);
    res.json(productos);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    await productosController.deleteProducto(req.params.id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/:id', async (req, res) => {
  const { id } = req.params;
  const { producto, precio, cantidad, comentario, nuevo_precio, porcentaje } = req.body;

  if (!producto || !precio || !cantidad || !comentario || !nuevo_precio || !porcentaje) {
    return res.status(400).json({ message: 'Faltan datos requeridos' });
  }

  try {
    await productosController.updateProducto(id, producto, precio, cantidad, comentario, nuevo_precio, porcentaje);
    res.json({ message: 'Producto actualizado correctamente' });
  } catch (error) {
    console.error('Error al actualizar el producto:', error);
    res.status(500).json({ message: 'Error al actualizar el producto' });
  }
});

// ...existing code...
router.post('/', async (req, res) => {
  const { producto, precio, cantidad, comentario, nuevo_precio, porcentaje} = req.body;
  try {
    if (!producto || !precio || !cantidad) {
      return res.status(400).json({ message: 'Faltan datos requeridos' });
    }
    const result = await productosController.insertarPedido(producto, precio, cantidad, comentario, nuevo_precio, porcentaje);
    res.status(201).json(result);
  } catch (error) {
    console.error('Error al procesar el pedido:', error);
    return res.status(500).json({ message: 'Error al procesar el pedido' });
  }
});
 
router.patch('/:id', async (req, res) => {
  const { id } = req.params;
  const estado = req.body.estado;

  if (!estado) {
    return res.status(400).json({ message: 'Faltan datos requeridos' });
  }

  try {
    await productosController.updateEstadoProducto(id, estado);
    res.json({ message: 'Producto actualizado correctamente' });
  } catch (error) {
    console.error('Error al actualizar el producto:', error);
    res.status(500).json({ message: 'Error al actualizar el producto' });
  }
});

module.exports = router;