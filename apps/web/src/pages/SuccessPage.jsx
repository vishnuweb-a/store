import React, { useState, useEffect } from 'react';
import { Helmet } from 'react-helmet';
import { Link } from 'react-router-dom';
import { CheckCircle, Package, ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import Header from '@/components/Header';
import Footer from '@/components/Footer';
import ShoppingCart from '@/components/ShoppingCart';
import { useCart } from '@/hooks/useCart';

const SuccessPage = () => {
  const [isCartOpen, setIsCartOpen] = useState(false);
  const { clearCart } = useCart();

  useEffect(() => {
    clearCart();
  }, [clearCart]);

  const orderNumber = `ORD-${Math.random().toString(36).substr(2, 9).toUpperCase()}`;
  const estimatedDelivery = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  return (
    <>
      <Helmet>
        <title>Order Confirmed - FRONTIVA</title>
        <meta name="description" content="Your order has been successfully placed." />
      </Helmet>

      <div className="min-h-screen flex flex-col">
        <Header setIsCartOpen={setIsCartOpen} />
        <ShoppingCart isCartOpen={isCartOpen} setIsCartOpen={setIsCartOpen} />

        <main className="flex-grow py-12">
          <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="text-center mb-12">
              <div className="inline-flex items-center justify-center w-20 h-20 bg-green-100 rounded-full mb-6">
                <CheckCircle className="h-12 w-12 text-green-600" />
              </div>
              <h1 className="font-display text-4xl md:text-5xl font-bold mb-4 text-foreground">Order Confirmed</h1>
              <p className="text-lg text-muted-foreground">
                Thank you for your purchase. Your order has been successfully placed.
              </p>
            </div>

            <div className="bg-card p-8 rounded-xl shadow-sm mb-8">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
                <div>
                  <h3 className="font-semibold text-sm text-muted-foreground mb-2">Order Number</h3>
                  <p className="text-lg font-bold text-card-foreground">{orderNumber}</p>
                </div>
                <div>
                  <h3 className="font-semibold text-sm text-muted-foreground mb-2">Estimated Delivery</h3>
                  <p className="text-lg font-bold text-card-foreground">{estimatedDelivery}</p>
                </div>
              </div>

              <div className="border-t border-border pt-6">
                <div className="flex items-start gap-4">
                  <div className="bg-secondary/10 p-3 rounded-lg">
                    <Package className="h-6 w-6 text-secondary" />
                  </div>
                  <div>
                    <h3 className="font-semibold mb-2 text-card-foreground">What happens next?</h3>
                    <ul className="space-y-2 text-sm text-muted-foreground">
                      <li>• You will receive an order confirmation email shortly</li>
                      <li>• We'll send you tracking information once your order ships</li>
                      <li>• Your items will be carefully packaged and dispatched</li>
                    </ul>
                  </div>
                </div>
              </div>
            </div>

            <div className="flex flex-col sm:flex-row gap-4 justify-center">
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
            </div>
          </div>
        </main>

        <Footer />
      </div>
    </>
  );
};

export default SuccessPage;