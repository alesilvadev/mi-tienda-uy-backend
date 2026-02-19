import { onRequest } from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { z } from 'zod';

admin.initializeApp();

const db = admin.firestore();
const app = express();

const allowedOrigins = process.env.FRONTEND_URL
  ? [process.env.FRONTEND_URL, 'http://localhost:3000']
  : true;

app.use(cors({ origin: allowedOrigins }));
app.use(express.json());

interface AuthRequest extends Request {
  user?: { uid: string; email: string; role: string };
}

const productSearchSchema = z.object({
  sku: z.string().min(1).max(50),
});

const addToOrderSchema = z.object({
  sku: z.string().min(1),
  quantity: z.number().int().positive(),
  color: z.string().optional(),
});

const createOrderSchema = z.object({
  listType: z.enum(['buy', 'wishlist']).default('buy'),
});

const updateOrderItemSchema = z.object({
  quantity: z.number().int().nonnegative().optional(),
  listType: z.enum(['buy', 'wishlist']).optional(),
});

const cashierLoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const createProductSchema = z.object({
  sku: z.string().min(1).max(50),
  name: z.string().min(1).max(200),
  price: z.number().positive(),
  description: z.string().optional(),
  image: z.string().optional(),
  colors: z.array(z.string()).optional(),
});

const updateProductSchema = createProductSchema.partial();

const authMiddleware = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const token = authHeader.substring(7);
    const decodedToken = await admin.auth().verifyIdToken(token);

    const userDoc = await db.collection('users').doc(decodedToken.uid).get();
    const userData = userDoc.data();

    req.user = {
      uid: decodedToken.uid,
      email: decodedToken.email || '',
      role: userData?.role || 'customer',
    };
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid token' });
  }
};

const cashierAuthMiddleware = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const token = authHeader.substring(7);
    const decodedToken = await admin.auth().verifyIdToken(token);

    const userDoc = await db.collection('users').doc(decodedToken.uid).get();
    const userData = userDoc.data();

    if (userData?.role !== 'cashier' && userData?.role !== 'admin') {
      return res.status(403).json({ error: 'Forbidden: Cashier access required' });
    }

    req.user = {
      uid: decodedToken.uid,
      email: decodedToken.email || '',
      role: userData?.role || 'customer',
    };
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid token' });
  }
};

const validateRequest = (schema: z.ZodSchema) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = req.body;
      schema.parse(data);
      next();
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: 'Validation error', details: error.errors });
      }
      res.status(400).json({ error: 'Invalid request' });
    }
  };
};

const apiRouter = express.Router();

apiRouter.get('/health', (req: Request, res: Response) => {
  res.status(200).json({ status: 'ok' });
});

apiRouter.post('/auth/login', validateRequest(cashierLoginSchema), async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;

    const user = await admin.auth().getUserByEmail(email);
    const customToken = await admin.auth().createCustomToken(user.uid);

    const userDoc = await db.collection('users').doc(user.uid).get();
    const userData = userDoc.data();

    if (userData?.role !== 'cashier' && userData?.role !== 'admin') {
      return res.status(403).json({ error: 'Access denied' });
    }

    res.json({ token: customToken });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Login failed';
    res.status(400).json({ error: errorMessage });
  }
});

apiRouter.get('/products/search', async (req: Request, res: Response) => {
  try {
    const { sku } = req.query;

    if (!sku || typeof sku !== 'string') {
      return res.status(400).json({ error: 'SKU parameter required' });
    }

    const snapshot = await db.collection('products')
      .where('sku', '==', sku)
      .limit(1)
      .get();

    if (snapshot.empty) {
      return res.status(404).json({ error: 'Product not found' });
    }

    const doc = snapshot.docs[0];
    res.json({
      id: doc.id,
      ...doc.data(),
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Search failed';
    res.status(500).json({ error: errorMessage });
  }
});

apiRouter.get('/products/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const doc = await db.collection('products').doc(id).get();

    if (!doc.exists) {
      return res.status(404).json({ error: 'Product not found' });
    }

    res.json({
      id: doc.id,
      ...doc.data(),
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Fetch failed';
    res.status(500).json({ error: errorMessage });
  }
});

apiRouter.post('/orders', validateRequest(createOrderSchema), async (req: Request, res: Response) => {
  try {
    const { listType } = req.body;
    const clientId = req.headers['x-client-id'] as string || 'anonymous';

    const orderRef = await db.collection('orders').add({
      clientId,
      status: 'pending',
      items: [],
      wishlistItems: [],
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    const orderCode = generateOrderCode();
    await orderRef.update({ orderCode });

    res.status(201).json({
      orderId: orderRef.id,
      orderCode,
      status: 'pending',
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Order creation failed';
    res.status(500).json({ error: errorMessage });
  }
});

apiRouter.post('/orders/:orderId/items', validateRequest(addToOrderSchema), async (req: Request, res: Response) => {
  try {
    const { orderId } = req.params;
    const { sku, quantity, color } = req.body;

    const productSnapshot = await db.collection('products')
      .where('sku', '==', sku)
      .limit(1)
      .get();

    if (productSnapshot.empty) {
      return res.status(404).json({ error: 'Product not found' });
    }

    const productDoc = productSnapshot.docs[0];
    const product = productDoc.data();

    const orderDoc = await db.collection('orders').doc(orderId).get();
    if (!orderDoc.exists) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const item = {
      productId: productDoc.id,
      sku,
      name: product.name,
      price: product.price,
      quantity,
      color: color || null,
      addedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    await db.collection('orders').doc(orderId).update({
      items: admin.firestore.FieldValue.arrayUnion(item),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.status(201).json({
      message: 'Item added',
      item,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to add item';
    res.status(500).json({ error: errorMessage });
  }
});

apiRouter.get('/orders/:orderId', async (req: Request, res: Response) => {
  try {
    const { orderId } = req.params;
    const doc = await db.collection('orders').doc(orderId).get();

    if (!doc.exists) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const data = doc.data();
    const subtotal = (data?.items || []).reduce((sum: number, item: any) => sum + (item.price * item.quantity), 0);

    res.json({
      id: doc.id,
      ...data,
      subtotal,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Fetch failed';
    res.status(500).json({ error: errorMessage });
  }
});

apiRouter.put('/orders/:orderId/items/:itemIndex', validateRequest(updateOrderItemSchema), async (req: Request, res: Response) => {
  try {
    const { orderId, itemIndex } = req.params;
    const { quantity, listType } = req.body;
    const index = parseInt(itemIndex);

    const orderDoc = await db.collection('orders').doc(orderId).get();
    if (!orderDoc.exists) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const orderData = orderDoc.data();
    if (!orderData?.items || index < 0 || index >= orderData.items.length) {
      return res.status(400).json({ error: 'Invalid item index' });
    }

    if (quantity !== undefined && quantity >= 0) {
      orderData.items[index].quantity = quantity;
    }

    if (listType) {
      if (listType === 'wishlist') {
        const item = orderData.items.splice(index, 1)[0];
        orderData.wishlistItems = orderData.wishlistItems || [];
        orderData.wishlistItems.push(item);
      } else if (listType === 'buy' && !orderData.items.includes(orderData.items[index])) {
        const item = orderData.wishlistItems.splice(index, 1)[0];
        orderData.items.push(item);
      }
    }

    await db.collection('orders').doc(orderId).update({
      items: orderData.items,
      wishlistItems: orderData.wishlistItems,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({ message: 'Item updated' });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Update failed';
    res.status(500).json({ error: errorMessage });
  }
});

apiRouter.delete('/orders/:orderId/items/:itemIndex', async (req: Request, res: Response) => {
  try {
    const { orderId, itemIndex } = req.params;
    const index = parseInt(itemIndex);

    const orderDoc = await db.collection('orders').doc(orderId).get();
    if (!orderDoc.exists) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const orderData = orderDoc.data();
    if (!orderData?.items || index < 0 || index >= orderData.items.length) {
      return res.status(400).json({ error: 'Invalid item index' });
    }

    orderData.items.splice(index, 1);

    await db.collection('orders').doc(orderId).update({
      items: orderData.items,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({ message: 'Item deleted' });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Delete failed';
    res.status(500).json({ error: errorMessage });
  }
});

apiRouter.post('/orders/:orderId/close', async (req: Request, res: Response) => {
  try {
    const { orderId } = req.params;

    const orderDoc = await db.collection('orders').doc(orderId).get();
    if (!orderDoc.exists) {
      return res.status(404).json({ error: 'Order not found' });
    }

    await db.collection('orders').doc(orderId).update({
      status: 'closed',
      closedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({ message: 'Order closed' });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Close failed';
    res.status(500).json({ error: errorMessage });
  }
});

apiRouter.get('/orders/code/:orderCode', cashierAuthMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { orderCode } = req.params;

    const snapshot = await db.collection('orders')
      .where('orderCode', '==', orderCode)
      .limit(1)
      .get();

    if (snapshot.empty) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const doc = snapshot.docs[0];
    const data = doc.data();
    const subtotal = (data?.items || []).reduce((sum: number, item: any) => sum + (item.price * item.quantity), 0);

    res.json({
      id: doc.id,
      ...data,
      subtotal,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Fetch failed';
    res.status(500).json({ error: errorMessage });
  }
});

apiRouter.put('/orders/:orderId/status', cashierAuthMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { orderId } = req.params;
    const { status } = req.body;

    const validStatuses = ['pending', 'confirmed', 'processing', 'ready', 'completed', 'cancelled'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    const orderDoc = await db.collection('orders').doc(orderId).get();
    if (!orderDoc.exists) {
      return res.status(404).json({ error: 'Order not found' });
    }

    await db.collection('orders').doc(orderId).update({
      status,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({ message: 'Status updated', status });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Update failed';
    res.status(500).json({ error: errorMessage });
  }
});

apiRouter.post('/admin/products', validateRequest(createProductSchema), async (req: Request, res: Response) => {
  try {
    const { sku, name, price, description, image, colors } = req.body;

    const existing = await db.collection('products')
      .where('sku', '==', sku)
      .limit(1)
      .get();

    if (!existing.empty) {
      return res.status(400).json({ error: 'SKU already exists' });
    }

    const productRef = await db.collection('products').add({
      sku,
      name,
      price,
      description: description || '',
      image: image || '',
      colors: colors || [],
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.status(201).json({
      id: productRef.id,
      sku,
      name,
      price,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Creation failed';
    res.status(500).json({ error: errorMessage });
  }
});

apiRouter.put('/admin/products/:productId', validateRequest(updateProductSchema), async (req: Request, res: Response) => {
  try {
    const { productId } = req.params;
    const updates = req.body;

    const productDoc = await db.collection('products').doc(productId).get();
    if (!productDoc.exists) {
      return res.status(404).json({ error: 'Product not found' });
    }

    await db.collection('products').doc(productId).update({
      ...updates,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({ message: 'Product updated' });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Update failed';
    res.status(500).json({ error: errorMessage });
  }
});

apiRouter.post('/admin/products/import', async (req: Request, res: Response) => {
  try {
    const { products } = req.body;

    if (!Array.isArray(products)) {
      return res.status(400).json({ error: 'Products must be an array' });
    }

    const batch = db.batch();
    let imported = 0;

    for (const product of products) {
      const productSchema = createProductSchema.safeParse(product);
      if (!productSchema.success) continue;

      const docRef = db.collection('products').doc();
      batch.set(docRef, {
        ...productSchema.data,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      imported++;
    }

    await batch.commit();
    res.json({ imported });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Import failed';
    res.status(500).json({ error: errorMessage });
  }
});

apiRouter.get('/admin/products', async (req: Request, res: Response) => {
  try {
    const snapshot = await db.collection('products').limit(100).get();
    const products = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
    }));

    res.json({ products });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Fetch failed';
    res.status(500).json({ error: errorMessage });
  }
});

function generateOrderCode(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 8; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

app.use('/api', apiRouter);

app.use((req: Request, res: Response) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

app.use((error: any, req: Request, res: Response, next: NextFunction) => {
  res.status(500).json({ error: 'Internal server error' });
});

export const api = onRequest({ cors: false }, app);
