require('dotenv').config();
const express = require('express');
const axios = require('axios');
const app = express();
const { saveTokenToDB, getLatestTokenFromDB, saveOrder, saveItems, clearAllOrderData, saveDepartmentCity} = require('./db');
const { DateTime } = require('luxon');

const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI;

let tokens = {};

// Ruta de autenticación: devuelve la URL de autenticación en JSON
app.get('/', (req, res) => {
    const authURL = `https://auth.mercadolibre.com.co/authorization?response_type=code&client_id=${CLIENT_ID}&redirect_uri=${REDIRECT_URI}`;

    res.send(`
    <!DOCTYPE html>
    <html lang="es">
    <head>
      <meta charset="UTF-8" />
      <title>Conectar con Mercado Libre</title>
      <style>
        body {
          font-family: Arial, sans-serif;
          background: linear-gradient(145deg, #ffe600, #fffde7);
          height: 100vh;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .container {
          text-align: center;
        }
        .btn {
          background-color: #3483fa;
          color: white;
          padding: 16px 32px;
          font-size: 18px;
          text-decoration: none;
          border-radius: 8px;
          transition: background-color 0.3s ease;
        }
        .btn:hover {
          background-color: #2968c8;
        }
        h1 {
          margin-bottom: 30px;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>Autenticación con Mercado Libre</h1>
        <a href="${authURL}" class="btn">🔐 Conectar con Mercado Libre</a>
      </div>
    </body>
    </html>
  `);
});



// Callback de autorización para obtener el token
app.get('/callback', async (req, res) => {
    const code = req.query.code;
    const days = parseInt(req.query.days) || 20; // 💡 Agrega el param days (default 7)
    if (!code) return res.status(400).json({ error: "No se recibió código" });

    try {
        const response = await axios.post('https://api.mercadolibre.com/oauth/token', null, {
            params: {
                grant_type: 'authorization_code',
                client_id: CLIENT_ID,
                client_secret: CLIENT_SECRET,
                code: code,
                redirect_uri: REDIRECT_URI
            },
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });

        tokens = response.data;
        await saveTokenToDB(tokens.access_token);

        // 🚀 Llama con días
        const orders = await fetchOrders(tokens.access_token, tokens.user_id, days);

        res.json({
            message: `Token guardado y órdenes obtenidas correctamente para los últimos ${days} días`,
            orders
        });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Error al obtener el token o las órdenes" });
    }
});

async function fetchOrders(access_token, user_id, days = 3) {
    await clearAllOrderData();

    const hoy = DateTime.now().setZone('America/Bogota').startOf('day');
const desde = hoy.minus({ days: days - 1 }); // Incluye hoy como día completo
const hasta = hoy.endOf('day');

const isoDateFrom = desde.toISO();
const isoDateTo = hasta.toISO();


    let allOrders = [];
    const limit = 50;
    let offset = 0;

    while (true) {
        const paginatedURL = `https://api.mercadolibre.com/orders/search?seller=${user_id}&date_created.from=${isoDateFrom}&date_created.to=${isoDateTo}&sort=date_desc&limit=${limit}&offset=${offset}`;
        const response = await axios.get(paginatedURL, {
            headers: { Authorization: `Bearer ${access_token}` }
        });

        const currentOrders = response.data.results;
        if (!currentOrders.length) break;

        allOrders.push(...currentOrders);
        if (currentOrders.length < limit) break;
        offset += limit;
    }

    allOrders = allOrders.filter(order => {
    const created = DateTime.fromISO(order.date_created).setZone('America/Bogota');
    return created >= desde && created <= hasta;
});


    const orders = await Promise.all(allOrders.map(async (order) => {
        const buyerName = typeof order.buyer === 'object'
            ? order.buyer.nickname || order.buyer.first_name || order.buyer.name || 'Desconocido'
            : 'Desconocido';

        const totalNumber = order.total_amount || 0;

        let dateCreated = null;
        let cargosPorVenta = 0;

        try {
            const debugRes = await axios.get(`https://api.mercadolibre.com/orders/${order.id}`, {
                headers: { Authorization: `Bearer ${access_token}` }
            });
            dateCreated = DateTime.fromISO(debugRes.data.date_created)
                .setZone('America/Bogota')
                .startOf('minute')
                .toJSDate();
            cargosPorVenta = Array.isArray(debugRes.data.payments)
                ? debugRes.data.payments.reduce((sum, p) => sum + (p.marketplace_fee || 0), 0)
                : 0;
        } catch (err) {
            console.warn(`⚠️ Error al obtener detalles de la orden ${order.id}: ${err.message}`);
        }

        const items = [];
        if (Array.isArray(order.order_items)) {
            for (const i of order.order_items) {
                const itemId = i.item?.id;
                let skuVendedor = 'No definido por el vendedor';
                let skuMeli = '⚠️ No definido por el vendedor';

                if (itemId) {
                    try {
                        const itemRes = await axios.get(`https://api.mercadolibre.com/items/${itemId}`, {
                            headers: { Authorization: `Bearer ${access_token}` }
                        });
                        const skuAttr = itemRes.data.attributes.find(a => a.id === 'SELLER_SKU');
                        skuVendedor = skuAttr?.value_name || 'No definido por el vendedor';
                        skuMeli = itemRes.data.seller_custom_field || '⚠️ No definido por el vendedor';
                    } catch (err) {
                        console.warn(`⚠️ No se pudo obtener info para item ${itemId}: ${err.message}`);
                    }
                }

                items.push({
                    sku: skuVendedor,
                    sku_meli: itemId,
                    title: i.item?.title || 'Sin título',
                    quantity: i.quantity || 0,
                    unit_price: i.unit_price?.toString() || '0'
                });
            }
        }

        let billingInfo = {
            name: 'No disponible',
            id_type: 'No disponible',
            id_number: 'No disponible',
            address: 'No disponible'
        };

        try {
            const billingRes = await axios.get(`https://api.mercadolibre.com/orders/${order.id}/billing_info`, {
                headers: { Authorization: `Bearer ${access_token}`, 'x-version': '2' }
            });
            const info = billingRes.data?.buyer?.billing_info;
            if (info && info.identification && info.address) {
                billingInfo = {
                    name: [info.name, info.last_name].filter(Boolean).join(' ').trim() || 'Desconocido',
                    id_type: info?.identification?.type || 'Desconocido',
                    id_number: info?.identification?.number || 'Desconocido',
                    address: [
                        info?.address?.street_name,
                        info?.address?.street_number,
                        info?.address?.city_name
                    ].filter(Boolean).join(' ').trim() || 'Sin dirección'
                };
            }
        } catch (err) {
            console.warn(`⚠️ No se pudo obtener billing_info para la orden ${order.id}: ${err.message}`);
        }

        let costoEnvio = 0;
        let ciudad = null;
        let departamento = null;

        try {
            const shippingRes = await axios.get(`https://api.mercadolibre.com/shipments/${order.shipping?.id}`, {
                headers: { Authorization: `Bearer ${access_token}` }
            });
            costoEnvio = shippingRes.data.base_cost || 0;
            ciudad = shippingRes.data.receiver_address?.city?.name || null;
            departamento = shippingRes.data.receiver_address?.state?.name || null;
        } catch (err) {
            console.warn(`⚠️ No se pudo obtener envío para la orden ${order.id}: ${err.message}`);
        }

        await saveOrder({
            id: order.id,
            status: order.status,
            date_created: dateCreated,
            buyer_name: buyerName,
            nombre_cliente: billingInfo.name,
            buyer_id_type: billingInfo.id_type,
            buyer_id_number: billingInfo.id_number,
            buyer_address: billingInfo.address,
            cargos_por_venta: cargosPorVenta,
            costoEnvio,
            ciudad,
            departamento
        });

        await saveItems(order.id, items);

        return {
            id: order.id,
            buyer: buyerName,
            date: DateTime.fromISO(order.date_created)
             .setZone('America/Bogota')
             .toFormat('yyyy-MM-dd HH:mm:ss'),  
            total: totalNumber,
            cargosPorVenta,
            costoEnvio,
            billingInfo,
            items
        };
    }));

    return orders;
}

// 🚀 Nueva ruta para traer e insertar departamentos y ciudades
app.get('/fetch-departments-cities', async (req, res) => {
    try {
        const countryRes = await axios.get('https://api.mercadolibre.com/classified_locations/countries/CO');
        const departments = countryRes.data.states;

        for (const dept of departments) {
            const stateId = dept.id;
            const stateName = dept.name;

            const citiesRes = await axios.get(`https://api.mercadolibre.com/classified_locations/states/${stateId}`);
            const cities = citiesRes.data.cities;

            for (const city of cities) {
                await saveDepartmentCity(stateName, city.name);
            }
        }

        res.json({ message: 'Departamentos y ciudades insertados correctamente.' });
    } catch (err) {
        console.error('❌ Error al traer ciudades y departamentos:', err.message);
        res.status(500).json({ error: 'Error al traer ciudades y departamentos' });
    }
});


app.listen(3000, () => {
    console.log('Servidor corriendo en http://localhost:3000');
});
