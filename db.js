
const sql = require('mssql');
const { DateTime } = require('luxon');
require('dotenv').config(); // Asegúrate que esté arriba del archivo

const config = {
    server: process.env.DB_SERVER,
    port: parseInt(process.env.DB_PORT, 10),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    options: {
        encrypt: true,
        trustServerCertificate: true
    }
};

async function clearAllOrderData() {
    try {
        const pool = await sql.connect(config);
        await pool.request().query(`
            DELETE FROM orders.order_taxes;
            DELETE FROM orders.order_items;
            DELETE FROM orders.orders;
        `);
        console.log('🧹 Tablas limpiadas correctamente.');
    } catch (err) {
        console.error('❌ Error al limpiar las tablas:', err);
    }
}



async function saveTokenToDB(token) {
    try {
        const pool = await sql.connect(config);
        await pool.request()
            .input('token', sql.NVarChar(sql.MAX), token)
            .query(`INSERT INTO conf.token (Token) VALUES (@token)`);
        console.log('✅ Token guardado');
    } catch (err) {
        console.error('❌ Error al guardar token:', err);
    }
}

async function getLatestTokenFromDB() {
    try {
        const pool = await sql.connect(config);
        const result = await pool.request()
            .query(`SELECT TOP 1 Token FROM conf.token ORDER BY tokenID DESC`);
        return result.recordset[0]?.Token;
    } catch (err) {
        console.error('❌ Error al obtener token:', err);
        return null;
    }
}

// 🔽 FUNCIONES PARA GUARDAR ÓRDENES 🔽

async function saveOrder(order) {
    try {
        const pool = await sql.connect(config);
// console.log(`🕵️ Revisando date_created crudo para orden ${order.id}:`, order.date_created);

     const dateCreated = order.date_created instanceof Date && !isNaN(order.date_created)
  ? new Date(DateTime.fromJSDate(order.date_created, { zone: 'utc' })
      .setZone('America/Bogota')
      .toFormat('yyyy-MM-dd'))
  : null;




// console.log(`[DEBUG] Orden ${order.id} fecha original: ${order.date_created}, convertida: ${dateCreated}`);



        const isValidDate = dateCreated instanceof Date && !isNaN(dateCreated);

        // 🔥 BORRA datos anteriores completamente por ID
        await pool.request()
            .input('id', sql.Numeric, order.id)
            .query(`
        DELETE FROM orders.order_taxes WHERE order_id = @id;
        DELETE FROM orders.order_items WHERE order_id = @id;
        DELETE FROM orders.orders WHERE id = @id;
      `);

        // Inserta la orden "limpia"
        await pool.request()
            .input('id', sql.Numeric, order.id)
            .input('buyer_name', sql.VarChar(200), order.buyer_name)
            .input('nombre_cliente', sql.VarChar(200), order.nombre_cliente)
            .input('buyer_id_type', sql.VarChar(20), order.buyer_id_type)
            .input('buyer_id_number', sql.VarChar(20), order.buyer_id_number)
            .input('buyer_address', sql.NVarChar(sql.MAX), order.buyer_address)
            .input('date_created', sql.SmallDateTime, isValidDate ? dateCreated : null)
            .input('cargos_por_venta', sql.Numeric, order.cargos_por_venta)
            .input('costo_envio', sql.Numeric, order.costoEnvio)
            .input('status', sql.VarChar(20), order.status)
            .input('ciudad', sql.VarChar(100), order.ciudad)
            .query(`
        INSERT INTO orders.orders (
  id, buyer_name, nombre_cliente, buyer_id_type, buyer_id_number,
  buyer_address, date_created,
  cargos_por_venta, costo_envio, status, ciudad
) VALUES (
  @id, @buyer_name, @nombre_cliente, @buyer_id_type, @buyer_id_number,
  @buyer_address, @date_created,
  @cargos_por_venta, @costo_envio, @status, @ciudad
);

      `);

        // console.log(`✅ Orden ${order.id} guardada con éxito.`);
    } catch (err) {
        console.error(`❌ Error al guardar la orden ${order.id}:`, err);
    }
}


async function saveItems(orderId, items) {
    try {
        const pool = await sql.connect(config);

        // Limpia ítems existentes primero (una sola vez por orden)
        await pool.request()
            .input('order_id', sql.Numeric, orderId)
            .query(`DELETE FROM orders.order_items WHERE order_id = @order_id`);

        for (const item of items) {
            const unitPrice = typeof item.unit_price === 'number'
                ? item.unit_price
                : parseFloat(item.unit_price?.toString().replace(/[^\d.-]/g, '')) || 0;

            await pool.request()
                .input('order_id', sql.Numeric, orderId)
                .input('sku_vendedor', sql.VarChar(200), item.sku)
                .input('sku_ml', sql.VarChar(200), item.sku_meli)
                .input('title', sql.VarChar(200), item.title)
                .input('quantity', sql.Int, item.quantity)
                .input('unit_price', sql.Numeric, unitPrice)
                .query(`
                    INSERT INTO orders.order_items 
                    (order_id, sku_vendedor, sku_ml, title, quantity, unit_price)
                    VALUES (@order_id, @sku_vendedor, @sku_ml, @title, @quantity, @unit_price)
                `);
        }
    } catch (err) {
        console.error(`❌ Error al guardar ítems para la orden ${orderId}:`, err);
    }
}




async function saveTaxes(orderId, taxes) {
    try {
        const pool = await sql.connect(config);

        // Solo eliminar impuestos existentes una vez por orden
        await pool.request()
            .input('order_id', sql.Numeric, orderId)
            .query(`DELETE FROM orders.order_taxes WHERE order_id = @order_id`);

        for (const tax of taxes) {
            const taxValue = typeof tax.value === 'number'
                ? tax.value
                : parseFloat(tax.value?.toString().replace(/[^\d.-]/g, '')) || 0;

            await pool.request()
                .input('order_id', sql.Numeric, orderId)
                .input('tax_name', sql.VarChar(200), tax.name)
                .input('tax_value', sql.Numeric, taxValue)
                .query(`
                  INSERT INTO orders.order_taxes (order_id, tax_name, tax_value)
                  VALUES (@order_id, @tax_name, @tax_value)
                `);
        }
    } catch (err) {
        console.error(`❌ Error al guardar impuestos para la orden ${orderId}:`, err);
    }
}



module.exports = {
    saveTokenToDB,
    getLatestTokenFromDB,
    saveOrder,
    saveItems,
    saveTaxes,
    clearAllOrderData 
};
