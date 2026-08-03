import React, { useCallback, useEffect, useState } from 'react';
import { Helmet } from 'react-helmet';
import { Loader2, Pencil, Plus, Trash2, Upload, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import { supabase } from '@/lib/supabase';
import { uploadImage } from '@/lib/cloudinary';
import { listOrders } from '@/api/OrdersApi';

const EMPTY_PRODUCT = {
  title: '',
  subtitle: '',
  description: '',
  ribbon: '',
  price: '',
  discount_price: '',
  sku: '',
  weight: '',
  track_quantity: false,
  stock: 0,
  sizes: [],
  image_url: '',
  cloudinary_public_id: '',
  active: true,
};

const ProductForm = ({ initialProduct, onCancel, onSaved }) => {
  const [form, setForm] = useState({ ...EMPTY_PRODUCT, ...initialProduct });
  const [isSaving, setIsSaving] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const { toast } = useToast();

  const setField = (name, value) => setForm((prev) => ({ ...prev, [name]: value }));

  const handleImageChange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setIsUploading(true);
    try {
      const { image_url, cloudinary_public_id } = await uploadImage(file);
      setForm((prev) => ({ ...prev, image_url, cloudinary_public_id }));
      toast({ title: 'Image uploaded' });
    } catch (error) {
      toast({ variant: 'destructive', title: 'Upload failed', description: error.message });
    } finally {
      setIsUploading(false);
    }
  };

  const updateSize = (index, key, value) => {
    setForm((prev) => ({
      ...prev,
      sizes: prev.sizes.map((entry, i) => (i === index ? { ...entry, [key]: value } : entry)),
    }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();

    if (!form.title.trim()) {
      toast({ variant: 'destructive', title: 'Title is required' });
      return;
    }

    setIsSaving(true);

    const payload = {
      title: form.title.trim(),
      subtitle: form.subtitle || null,
      description: form.description || null,
      ribbon: form.ribbon || null,
      price: Number(form.price) || 0,
      discount_price: form.discount_price === '' ? null : Number(form.discount_price),
      sku: form.sku || null,
      weight: form.weight === '' ? null : Number(form.weight),
      track_quantity: form.track_quantity,
      stock: Number(form.stock) || 0,
      sizes: form.sizes
        .filter((entry) => entry.size)
        .map((entry) => ({ size: String(entry.size), stock: Number(entry.stock) || 0 })),
      image_url: form.image_url || null,
      cloudinary_public_id: form.cloudinary_public_id || null,
      active: form.active,
    };

    const { error } = form.id
      ? await supabase.from('products').update(payload).eq('id', form.id)
      : await supabase.from('products').insert(payload);

    setIsSaving(false);

    if (error) {
      toast({ variant: 'destructive', title: 'Save failed', description: error.message });
      return;
    }

    toast({ title: form.id ? 'Product updated' : 'Product added' });
    onSaved();
  };

  return (
    <form onSubmit={handleSubmit} className="bg-card p-6 rounded-xl shadow-sm space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="font-display text-2xl font-bold text-card-foreground">
          {form.id ? 'Edit Product' : 'Add Product'}
        </h2>
        <Button type="button" variant="ghost" size="icon" onClick={onCancel} aria-label="Close form">
          <X className="h-4 w-4" />
        </Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="md:col-span-2">
          <label className="block text-sm font-medium mb-2 text-card-foreground" htmlFor="title">Title</label>
          <Input id="title" value={form.title} onChange={(e) => setField('title', e.target.value)} />
        </div>
        <div className="md:col-span-2">
          <label className="block text-sm font-medium mb-2 text-card-foreground" htmlFor="subtitle">Subtitle</label>
          <Input id="subtitle" value={form.subtitle || ''} onChange={(e) => setField('subtitle', e.target.value)} />
        </div>
        <div className="md:col-span-2">
          <label className="block text-sm font-medium mb-2 text-card-foreground" htmlFor="description">Description</label>
          <Textarea id="description" rows={4} value={form.description || ''} onChange={(e) => setField('description', e.target.value)} />
        </div>
        <div>
          <label className="block text-sm font-medium mb-2 text-card-foreground" htmlFor="ribbon">Ribbon</label>
          <Input id="ribbon" value={form.ribbon || ''} onChange={(e) => setField('ribbon', e.target.value)} placeholder="New" />
        </div>
        <div>
          <label className="block text-sm font-medium mb-2 text-card-foreground" htmlFor="sku">SKU</label>
          <Input id="sku" value={form.sku || ''} onChange={(e) => setField('sku', e.target.value)} />
        </div>
        <div>
          <label className="block text-sm font-medium mb-2 text-card-foreground" htmlFor="price">Price (₹)</label>
          <Input id="price" type="number" step="0.01" value={form.price} onChange={(e) => setField('price', e.target.value)} />
        </div>
        <div>
          <label className="block text-sm font-medium mb-2 text-card-foreground" htmlFor="discount_price">Discount Price (₹)</label>
          <Input id="discount_price" type="number" step="0.01" value={form.discount_price ?? ''} onChange={(e) => setField('discount_price', e.target.value)} />
        </div>
        <div>
          <label className="block text-sm font-medium mb-2 text-card-foreground" htmlFor="weight">Weight</label>
          <Input id="weight" type="number" step="0.01" value={form.weight ?? ''} onChange={(e) => setField('weight', e.target.value)} />
        </div>
        <div>
          <label className="block text-sm font-medium mb-2 text-card-foreground" htmlFor="stock">Stock (used when no sizes)</label>
          <Input id="stock" type="number" value={form.stock} onChange={(e) => setField('stock', e.target.value)} />
        </div>
      </div>

      <div className="flex flex-wrap gap-6">
        <label className="flex items-center gap-2 text-sm font-medium text-card-foreground">
          <input type="checkbox" checked={form.track_quantity} onChange={(e) => setField('track_quantity', e.target.checked)} />
          Track quantity
        </label>
        <label className="flex items-center gap-2 text-sm font-medium text-card-foreground">
          <input type="checkbox" checked={form.active} onChange={(e) => setField('active', e.target.checked)} />
          Active
        </label>
      </div>

      <div>
        <span className="block text-sm font-medium mb-2 text-card-foreground">Image</span>
        <div className="flex items-center gap-4">
          {form.image_url && (
            <img src={form.image_url} alt="Product" loading="lazy" className="w-20 h-20 object-cover rounded-lg" />
          )}
          <label className="inline-flex items-center gap-2 px-4 py-2 rounded-md border border-border cursor-pointer text-sm font-medium text-card-foreground hover:bg-muted">
            {isUploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
            {isUploading ? 'Uploading...' : 'Upload to Cloudinary'}
            <input type="file" accept="image/*" className="hidden" onChange={handleImageChange} disabled={isUploading} />
          </label>
        </div>
      </div>

      <div>
        <span className="block text-sm font-medium mb-2 text-card-foreground">Sizes</span>
        <div className="space-y-2">
          {form.sizes.map((entry, index) => (
            <div key={index} className="flex items-center gap-2">
              <Input
                value={entry.size}
                onChange={(e) => updateSize(index, 'size', e.target.value)}
                placeholder="Size (S, M, L)"
                className="max-w-[10rem]"
              />
              <Input
                type="number"
                value={entry.stock}
                onChange={(e) => updateSize(index, 'stock', e.target.value)}
                placeholder="Stock"
                className="max-w-[8rem]"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Remove size"
                onClick={() => setForm((prev) => ({ ...prev, sizes: prev.sizes.filter((_, i) => i !== index) }))}
              >
                <Trash2 className="h-4 w-4 text-destructive" />
              </Button>
            </div>
          ))}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setForm((prev) => ({ ...prev, sizes: [...prev.sizes, { size: '', stock: 0 }] }))}
          >
            <Plus className="mr-2 h-4 w-4" /> Add size
          </Button>
        </div>
      </div>

      <div className="flex gap-3 pt-2">
        <Button type="submit" disabled={isSaving} className="bg-primary text-primary-foreground hover:bg-primary/90 font-semibold">
          {isSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
          {form.id ? 'Save Changes' : 'Add Product'}
        </Button>
        <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
};

const AdminPage = () => {
  const [tab, setTab] = useState('products');
  const [products, setProducts] = useState([]);
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null);
  const { toast } = useToast();

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [{ data, error }, orderRows] = await Promise.all([
        supabase.from('products').select('*').order('created_at', { ascending: false }),
        listOrders().catch(() => []),
      ]);

      if (error) throw new Error(error.message);
      setProducts(data || []);
      setOrders(orderRows);
    } catch (error) {
      toast({ variant: 'destructive', title: 'Could not load data', description: error.message });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleDelete = async (id) => {
    if (!window.confirm('Delete this product?')) return;

    const { error } = await supabase.from('products').delete().eq('id', id);
    if (error) {
      toast({ variant: 'destructive', title: 'Delete failed', description: error.message });
      return;
    }
    toast({ title: 'Product deleted' });
    loadData();
  };

  return (
    <>
      <Helmet>
        <title>Admin - FRONTIVA</title>
        <meta name="robots" content="noindex" />
      </Helmet>

      <div className="min-h-screen py-12">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="mb-8">
            <h1 className="font-display text-4xl font-bold mb-4 text-foreground">Admin</h1>
            <div className="flex gap-3">
              <Button
                variant={tab === 'products' ? 'default' : 'outline'}
                className={tab === 'products' ? 'bg-primary text-primary-foreground' : ''}
                onClick={() => setTab('products')}
              >
                Products
              </Button>
              <Button
                variant={tab === 'orders' ? 'default' : 'outline'}
                className={tab === 'orders' ? 'bg-primary text-primary-foreground' : ''}
                onClick={() => setTab('orders')}
              >
                Orders
              </Button>
            </div>
          </div>

          {loading ? (
            <div className="flex justify-center items-center h-64">
              <Loader2 className="h-12 w-12 text-primary animate-spin" />
            </div>
          ) : tab === 'products' ? (
            <div className="space-y-6">
              {editing ? (
                <ProductForm
                  initialProduct={editing}
                  onCancel={() => setEditing(null)}
                  onSaved={() => {
                    setEditing(null);
                    loadData();
                  }}
                />
              ) : (
                <Button
                  onClick={() => setEditing({ ...EMPTY_PRODUCT })}
                  className="bg-primary text-primary-foreground hover:bg-primary/90 font-semibold"
                >
                  <Plus className="mr-2 h-4 w-4" /> Add Product
                </Button>
              )}

              <div className="bg-card rounded-xl shadow-sm overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-muted-foreground">
                      <th className="p-4 font-medium">Image</th>
                      <th className="p-4 font-medium">Title</th>
                      <th className="p-4 font-medium">Price</th>
                      <th className="p-4 font-medium">Sizes</th>
                      <th className="p-4 font-medium">Active</th>
                      <th className="p-4 font-medium">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {products.length === 0 ? (
                      <tr><td colSpan={6} className="p-6 text-center text-muted-foreground">No products yet.</td></tr>
                    ) : (
                      products.map((product) => (
                        <tr key={product.id} className="border-b border-border last:border-0">
                          <td className="p-4">
                            {product.image_url ? (
                              <img src={product.image_url} alt={product.title} loading="lazy" className="w-12 h-12 object-cover rounded" />
                            ) : (
                              <div className="w-12 h-12 rounded bg-muted" />
                            )}
                          </td>
                          <td className="p-4 font-medium text-card-foreground">{product.title}</td>
                          <td className="p-4 text-card-foreground">₹{product.discount_price ?? product.price}</td>
                          <td className="p-4 text-muted-foreground">
                            {(product.sizes || []).map((entry) => `${entry.size}(${entry.stock})`).join(', ') || '—'}
                          </td>
                          <td className="p-4 text-muted-foreground">{product.active ? 'Yes' : 'No'}</td>
                          <td className="p-4">
                            <div className="flex gap-2">
                              <Button size="icon" variant="ghost" aria-label="Edit product" onClick={() => setEditing({ ...product, sizes: product.sizes || [] })}>
                                <Pencil className="h-4 w-4" />
                              </Button>
                              <Button size="icon" variant="ghost" aria-label="Delete product" onClick={() => handleDelete(product.id)}>
                                <Trash2 className="h-4 w-4 text-destructive" />
                              </Button>
                            </div>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            <div className="bg-card rounded-xl shadow-sm overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-muted-foreground">
                    <th className="p-4 font-medium">Order</th>
                    <th className="p-4 font-medium">Customer</th>
                    <th className="p-4 font-medium">Phone</th>
                    <th className="p-4 font-medium">Address</th>
                    <th className="p-4 font-medium">Items</th>
                    <th className="p-4 font-medium">Total</th>
                    <th className="p-4 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {orders.length === 0 ? (
                    <tr><td colSpan={7} className="p-6 text-center text-muted-foreground">No orders yet.</td></tr>
                  ) : (
                    orders.map((order) => (
                      <tr key={order.id} className="border-b border-border last:border-0 align-top">
                        <td className="p-4 font-medium text-card-foreground">FRV-{String(order.id).padStart(5, '0')}</td>
                        <td className="p-4 text-card-foreground">{order.customer_name}</td>
                        <td className="p-4 text-card-foreground">{order.phone}</td>
                        <td className="p-4 text-muted-foreground max-w-xs">
                          {order.address}
                          {order.landmark ? <span className="block">Landmark: {order.landmark}</span> : null}
                        </td>
                        <td className="p-4 text-muted-foreground">
                          {(order.items || []).map((item, index) => (
                            <div key={index}>
                              {item.title}
                              {item.size ? ` (${item.size})` : ''} × {item.quantity}
                            </div>
                          ))}
                        </td>
                        <td className="p-4 font-medium text-card-foreground">₹{order.total}</td>
                        <td className="p-4 text-muted-foreground">{order.status}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </>
  );
};

export default AdminPage;
