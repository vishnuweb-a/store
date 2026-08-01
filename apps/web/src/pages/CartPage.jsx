import React, { useState } from 'react';
import { Helmet } from 'react-helmet';
import { Link, useNavigate } from 'react-router-dom';
import { Trash2, ShoppingBag, ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useCart } from '@/hooks/useCart';
import Header from '@/components/Header';
import Footer from '@/components/Footer';
import ShoppingCart from '@/components/ShoppingCart';

const CartPage = () => {
  const [isCartOpen, setIsCartOpen] = useState(false);
  const { cartItems, removeFromCart, updateQuantity, getCartTotal } = useCart();
  const navigate = useNavigate();

  const handleCheckout = () => {
    navigate('/checkout');
  };

  return (
    <>
      <Helmet>
        <title>Shopping Cart - FRONTIVA</title>
        <meta name="description" content="Review your shopping cart and proceed to checkout." />
      </Helmet>

      <div className="min-h-screen flex flex-col">
        <Header setIsCartOpen={setIsCartOpen} />
        <ShoppingCart isCartOpen={isCartOpen} setIsCartOpen={setIsCartOpen} />

        <main className="flex-grow py-12">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="mb-8">
              <h1 className="font-display text-4xl md:text-5xl font-bold mb-4 text-foreground">Shopping Cart</h1>
              <p className="text-lg text-muted-foreground">Review your items before checkout</p>
            </div>

            {cartItems.length === 0 ? (
              <div className="text-center py-16">
                <ShoppingBag className="h-24 w-24 text-muted-foreground mx-auto mb-6" />
                <h2 className="font-display text-2xl font-bold mb-4 text-foreground">Your cart is empty</h2>
                <p className="text-muted-foreground mb-8">Add some products to get started</p>
                <Link to="/shop">
                  <Button className="bg-primary text-primary-foreground hover:bg-primary/90 font-semibold">
                    <ArrowLeft className="mr-2 h-4 w-4" />
                    Continue Shopping
                  </Button>
                </Link>
              </div>
            ) : (
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                <div className="lg:col-span-2 space-y-4">
                  {cartItems.map((item) => (
                    <div key={item.variant.id} className="bg-card p-6 rounded-xl shadow-sm">
                      <div className="flex gap-6">
                        <img
                          src={item.product.image}
                          alt={item.product.title}
                          className="w-32 h-32 object-cover rounded-lg"
                        />
                        <div className="flex-grow">
                          <h3 className="font-semibold text-lg mb-1 text-card-foreground">{item.product.title}</h3>
                          <p className="text-sm text-muted-foreground mb-2">{item.variant.title}</p>
                          <p className="text-lg font-bold text-primary mb-4">
                            {item.variant.sale_price_formatted || item.variant.price_formatted}
                          </p>
                          <div className="flex items-center gap-4">
                            <div className="flex items-center border border-border rounded-md">
                              <Button
                                onClick={() => updateQuantity(item.variant.id, Math.max(1, item.quantity - 1))}
                                size="sm"
                                variant="ghost"
                                className="px-3"
                              >
                                -
                              </Button>
                              <span className="px-4 text-card-foreground">{item.quantity}</span>
                              <Button
                                onClick={() => updateQuantity(item.variant.id, item.quantity + 1)}
                                size="sm"
                                variant="ghost"
                                className="px-3"
                              >
                                +
                              </Button>
                            </div>
                            <Button
                              onClick={() => removeFromCart(item.variant.id)}
                              size="sm"
                              variant="ghost"
                              className="text-destructive hover:text-destructive/90"
                            >
                              <Trash2 className="h-4 w-4 mr-2" />
                              Remove
                            </Button>
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>

                <div className="lg:col-span-1">
                  <div className="bg-card p-6 rounded-xl shadow-sm sticky top-24">
                    <h2 className="font-display text-2xl font-bold mb-6 text-card-foreground">Order Summary</h2>
                    <div className="space-y-4 mb-6">
                      <div className="flex justify-between text-card-foreground">
                        <span>Subtotal</span>
                        <span className="font-semibold">{getCartTotal()}</span>
                      </div>
                      <div className="flex justify-between text-card-foreground">
                        <span>Shipping</span>
                        <span className="text-muted-foreground">Calculated at checkout</span>
                      </div>
                      <div className="border-t border-border pt-4">
                        <div className="flex justify-between text-lg font-bold text-card-foreground">
                          <span>Total</span>
                          <span>{getCartTotal()}</span>
                        </div>
                      </div>
                    </div>
                    <Button
                      onClick={handleCheckout}
                      className="w-full bg-primary text-primary-foreground hover:bg-primary/90 font-semibold mb-4"
                    >
                      Proceed to Checkout
                    </Button>
                    <Link to="/shop">
                      <Button variant="outline" className="w-full">
                        <ArrowLeft className="mr-2 h-4 w-4" />
                        Continue Shopping
                      </Button>
                    </Link>
                  </div>
                </div>
              </div>
            )}
          </div>
        </main>

        <Footer />
      </div>
    </>
  );
};

export default CartPage;