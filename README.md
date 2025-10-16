# FreshFruit ERP Backend API

Backend API para el sistema ERP de distribución de frutas FreshFruit, construido con Express.js y PostgreSQL.

## Estructura del Proyecto

```
backend/
├── config/
│   └── database.js          # Configuración de la base de datos
├── database/
│   ├── schema.sql          # Esquema de la base de datos
│   └── sample_data.sql     # Datos de ejemplo
├── routes/
│   ├── products.js         # Rutas de productos/inventario
│   ├── categories.js       # Rutas de categorías
│   ├── customers.js        # Rutas de clientes
│   ├── suppliers.js        # Rutas de proveedores
│   ├── salesOrders.js      # Rutas de órdenes de venta
│   ├── purchaseOrders.js   # Rutas de órdenes de compra
│   ├── invoices.js         # Rutas de facturas
│   ├── stockMovements.js   # Rutas de movimientos de stock
│   └── dashboard.js        # Rutas del dashboard
├── server.js               # Servidor principal
├── package.json           # Dependencias del proyecto
└── .env.example           # Variables de entorno ejemplo
```

## Instalación

1. **Instalar dependencias:**
```bash
cd backend
npm install
```

2. **Configurar PostgreSQL:**
   - Crear la base de datos:
   ```sql
   CREATE DATABASE freshfruit_erp;
   ```
   
   - Ejecutar el esquema:
   ```bash
   psql -d freshfruit_erp -f database/schema.sql
   ```
   
   - Cargar datos de ejemplo:
   ```bash
   psql -d freshfruit_erp -f database/sample_data.sql
   ```

3. **Configurar variables de entorno:**
```bash
cp .env.example .env
# Editar .env con tus configuraciones de base de datos
```

4. **Iniciar el servidor:**
```bash
# Desarrollo
npm run dev

# Producción
npm start
```

## API Endpoints

### Productos
- `GET /api/products` - Obtener todos los productos
- `GET /api/products/:id` - Obtener un producto
- `POST /api/products` - Crear producto
- `PUT /api/products/:id` - Actualizar producto
- `DELETE /api/products/:id` - Eliminar producto
- `GET /api/products/alerts/low-stock` - Productos con stock bajo

### Categorías
- `GET /api/categories` - Obtener todas las categorías
- `GET /api/categories/:id` - Obtener una categoría
- `POST /api/categories` - Crear categoría
- `PUT /api/categories/:id` - Actualizar categoría
- `DELETE /api/categories/:id` - Eliminar categoría

### Clientes
- `GET /api/customers` - Obtener todos los clientes
- `GET /api/customers/:id` - Obtener un cliente
- `POST /api/customers` - Crear cliente
- `PUT /api/customers/:id` - Actualizar cliente
- `DELETE /api/customers/:id` - Eliminar cliente

### Proveedores
- `GET /api/suppliers` - Obtener todos los proveedores
- `GET /api/suppliers/:id` - Obtener un proveedor
- `POST /api/suppliers` - Crear proveedor
- `PUT /api/suppliers/:id` - Actualizar proveedor
- `DELETE /api/suppliers/:id` - Eliminar proveedor

### Órdenes de Venta
- `GET /api/sales-orders` - Obtener todas las órdenes de venta
- `GET /api/sales-orders/:id` - Obtener una orden de venta
- `POST /api/sales-orders` - Crear orden de venta
- `PUT /api/sales-orders/:id` - Actualizar estado de orden
- `DELETE /api/sales-orders/:id` - Cancelar orden

### Órdenes de Compra
- `GET /api/purchase-orders` - Obtener todas las órdenes de compra
- `GET /api/purchase-orders/:id` - Obtener una orden de compra
- `POST /api/purchase-orders` - Crear orden de compra
- `PUT /api/purchase-orders/:id/receive` - Recibir orden de compra

### Facturas
- `GET /api/invoices` - Obtener todas las facturas
- `GET /api/invoices/:id` - Obtener una factura
- `POST /api/invoices` - Crear factura desde orden de venta
- `PUT /api/invoices/:id/payment` - Registrar pago
- `GET /api/invoices/reports/overdue` - Facturas vencidas

### Movimientos de Stock
- `GET /api/stock-movements` - Obtener movimientos de stock
- `POST /api/stock-movements` - Crear ajuste de stock manual
- `GET /api/stock-movements/summary` - Resumen de movimientos

### Dashboard
- `GET /api/dashboard` - Obtener datos del dashboard
- `GET /api/dashboard/sales-chart` - Datos de gráfico de ventas
- `GET /api/dashboard/inventory-alerts` - Alertas de inventario

## Características

- **Base de datos relacional** con PostgreSQL
- **Transacciones** para operaciones críticas
- **Validación** de datos de entrada
- **Manejo de errores** robusto
- **Paginación** en endpoints de listado
- **Filtros** avanzados de búsqueda
- **Seguimiento de stock** automático
- **Generación automática** de números de orden/factura
- **Cálculos automáticos** de totales e impuestos

## Datos de Ejemplo

El archivo `sample_data.sql` incluye:
- 7 categorías de frutas
- 5 proveedores
- 7 clientes (incluyendo mayoristas y minoristas)
- 15 productos con stock inicial
- 3 órdenes de compra
- 4 órdenes de venta con items
- 2 facturas
- Movimientos de stock correspondientes
- 3 usuarios de ejemplo

## Variables de Entorno

```env
PORT=3001
DB_HOST=localhost
DB_PORT=5432
DB_NAME=freshfruit_erp
DB_USER=postgres
DB_PASSWORD=your_password
```

## Health Check

El servidor incluye un endpoint de health check en:
```
GET /api/health
```

Retorna el estado del servidor y timestamp actual.