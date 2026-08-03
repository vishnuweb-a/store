import React, { useEffect, useState } from 'react';
import { Helmet } from 'react-helmet';
import { Link, useLocation } from 'react-router-dom';
import { motion } from 'framer-motion';
import { ArrowRight, Banknote, CheckCircle, MapPin, Phone, User } from 'lucide-react';
import { Button } from '@/components/ui/button';
import Header from '@/components/Header';
import Footer from '@/components/Footer';
import ShoppingCart from '@/components/ShoppingCart';
import { useCart } from '@/hooks/useCart';
import { getLatestOrder } from '@/api/OrdersApi';

const SuccessPage = () => {
  const [isCartOpen, setIsCartOpen] = useState(false);
  const { clearCart } = useCart();
  const location = useLocation();

  const order = location.state?.order || getLatestOrder();

  useEffect(() => {
    clearCart();
  }, [clearCart]);

  const orderDate = order
    ? new Date(order.created_at).toLocaleDateString('en-IN', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      })
    : null;

  return (
    <>
      <Helmet>
        <title>Order Confirmed - FRONTIVA</title>
        <meta name="description" content="Your order has been placed successfully." />
      </Helmet>

      <div className="min-h-screen flex flex-col">
        <Header setIsCartOpen={setIsCartOpen} />
        <ShoppingCart isCartOpen={isCartOpen} setIsCartOpen={setIsCartOpen} />

        <main className="flex-grow py-12">
          <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8">
            <motion.div
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4 }}
              className="text-center mb-12"
            >
              <motion.div
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                transition={{ type: 'spring', stiffness: 260, damping: 20, delay: 0.1 }}
                className="inline-flex items-center justify-center w-24 h-24 bg-green-100 rounded-full mb-6"
              >
                <CheckCircle className="h-14 w-14 text-green-600" aria-hidden="true" />
              </motion.div>
              <h1 className="font-display text-4xl md:text-5xl font-bold mb-4 text-foreground">Thank You!</h1>
              <p className="text-lg text-muted-foreground">Your order has been placed successfully.</p>
            </motion.div>

            {order && (
              <motion.div
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.4, delay: 0.2 }}
                className="bg-card p-6 sm:p-8 rounded-xl shadow-sm mb-8"
              >
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 mb-6">
                  <div>
                    <h3 className="font-semibold text-sm text-muted-foreground mb-1">Order Number</h3>
                    <p className="text-lg font-bold text-card-foreground">{order.order_number}</p>
                  </div>
                  <div>
                    <h3 className="font-semibold text-sm text-muted-foreground mb-1">Order Date</h3>
                    <p className="text-lg font-bold text-card-foreground">{orderDate}</p>
                  </div>
                  <div>
                    <h3 className="font-semibold text-sm text-muted-foreground mb-1">Payment Method</h3>
                    <p className="text-lg font-bold text-card-foreground inline-flex items-center gap-2">
                      <Banknote className="h-5 w-5 text-primary" aria-hidden="true" />
                      Cash on Delivery
                    </p>
                  </div>
                  <div>
                    <h3 className="font-semibold text-sm text-muted-foreground mb-1">Total Amount</h3>
                    <p className="text-lg font-bold text-card-foreground">{order.total_formatted}</p>
                  </div>
                </div>

                <div className="border-t border-border pt-6 mb-6">
                  <h3 className="font-display text-xl font-bold mb-4 text-card-foreground">Delivery Details</h3>
                  <div className="space-y-3 text-sm">
                    <div className="flex items-start gap-3">
                      <User className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" aria-hidden="true" />
                      <span className="text-card-foreground">{order.customer.full_name}</span>
                    </div>
                    <div className="flex items-start gap-3">
                      <Phone className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" aria-hidden="true" />
                      <span className="text-card-foreground">{order.customer.phone}</span>
                    </div>
                    <div className="flex items-start gap-3">
                      <MapPin className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" aria-hidden="true" />
                      <span className="text-card-foreground">
                        {order.customer.address}
                        {order.customer.landmark && (
                          <span className="block text-muted-foreground">Landmark: {order.customer.landmark}</span>
                        )}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="border-t border-border pt-6">
                  <h3 className="font-display text-xl font-bold mb-4 text-card-foreground">Order Items</h3>
                  <div className="space-y-4">
                    {order.items.map((item) => (
                      <div key={item.variant_id} className="flex gap-3">
                        <img
                          src={item.image}
                          alt={item.title}
                          className="w-16 h-16 object-cover rounded"
                        />
                        <div className="flex-grow">
                          <p className="text-sm font-medium text-card-foreground">{item.title}</p>
                          <p className="text-xs text-muted-foreground">{item.variant_title}</p>
                          <p className="text-sm text-muted-foreground">
                            {item.unit_price_formatted} × {item.quantity}
                          </p>
                        </div>
                        <p className="text-sm font-semibold text-card-foreground whitespace-nowrap">
                          {item.line_total_formatted}
                        </p>
                      </div>
                    ))}
                  </div>
                  <div className="border-t border-border mt-4 pt-4 flex justify-between text-lg font-bold text-card-foreground">
                    <span>Total</span>
                    <span>{order.total_formatted}</span>
                  </div>
                </div>
              </motion.div>
            )}

            <motion.div
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4, delay: 0.3 }}
              className="flex flex-col sm:flex-row gap-4 justify-center"
            >
              <Link to="/shop">
                <Button size="lg" className="bg-primary text-primary-foreground hover:bg-primary/90 font-semibold w-full sm:w-auto">
                  Continue Shopping
                  <ArrowRight className="ml-2 h-5 w-5" />
                </Button>
              </Link>
              <Link to="/">
                <Button size="lg" variant="outline" className="w-full sm:w-auto">
                  Back to Home
                </Button>
              </Link>
            </motion.div>
          </div>
        </main>

        <Footer />
      </div>
    </>
  );
};

export default SuccessPage;
