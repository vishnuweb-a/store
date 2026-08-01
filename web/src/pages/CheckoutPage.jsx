import React, { useState } from 'react';
import { Helmet } from 'react-helmet';
import { useNavigate } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { useCart } from '@/hooks/useCart';
import { useToast } from '@/hooks/use-toast';
import { initializeCheckout } from '@/api/EcommerceApi';
import Header from '@/components/Header';
import Footer from '@/components/Footer';
import ShoppingCart from '@/components/ShoppingCart';

const CheckoutPage = () => {
  const [isCartOpen, setIsCartOpen] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [sameAsShipping, setSameAsShipping] = useState(true);
  const { cartItems, getCartTotal } = useCart();
  const { toast } = useToast();
  const navigate = useNavigate();

  const [shippingInfo, setShippingInfo] = useState({
    fullName: '',
    address: '',
    city: '',
    state: '',
    zipCode: '',
  });

  const [billingInfo, setBillingInfo] = useState({
    fullName: '',
    address: '',
    city: '',
    state: '',
    zipCode: '',
  });

  const handleShippingChange = (e) => {
    setShippingInfo({ ...shippingInfo, [e.target.name]: e.target.value });
  };

  const handleBillingChange = (e) => {
    setBillingInfo({ ...billingInfo, [e.target.name]: e.target.value });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();

    if (cartItems.length === 0) {
      toast({
        title: 'Cart is empty',
        description: 'Please add items to your cart before checking out.',
        variant: 'destructive',
      });
      return;
    }

    setIsProcessing(true);

    try {
      const items = cartItems.map(item => ({
        variant_id: item.variant.id,
        quantity: item.quantity,
      }));

      const successUrl = `${window.location.origin}/success`;
      const cancelUrl = window.location.href;

      const { url } = await initializeCheckout({ items, successUrl, cancelUrl });

      window.location.href = url;
    } catch (error) {
      toast({
        title: 'Checkout failed',
        description: 'There was a problem processing your order. Please try again.',
        variant: 'destructive',
      });
      setIsProcessing(false);
    }
  };

  if (cartItems.length === 0) {
    navigate('/cart');
    return null;
  }

  return (
    <>
      <Helmet>
        <title>Checkout - FRONTIVA</title>
        <meta name="description" content="Complete your purchase securely." />
      </Helmet>

      <div className="min-h-screen flex flex-col">
        <Header setIsCartOpen={setIsCartOpen} />
        <ShoppingCart isCartOpen={isCartOpen} setIsCartOpen={setIsCartOpen} />

        <main className="flex-grow py-12">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="mb-8">
              <h1 className="font-display text-4xl md:text-5xl font-bold mb-4 text-foreground">Checkout</h1>
              <p className="text-lg text-muted-foreground">Complete your order</p>
            </div>

            <form onSubmit={handleSubmit}>
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                <div className="lg:col-span-2 space-y-8">
                  <div className="bg-card p-6 rounded-xl shadow-sm">
                    <h2 className="font-display text-2xl font-bold mb-6 text-card-foreground">Shipping Information</h2>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div className="md:col-span-2">
                        <label htmlFor="shipping-fullName" className="block text-sm font-medium mb-2 text-card-foreground">
                          Full Name
                        </label>
                        <Input
                          id="shipping-fullName"
                          name="fullName"
                          type="text"
                          required
                          value={shippingInfo.fullName}
                          onChange={handleShippingChange}
                          className="text-foreground"
                        />
                      </div>
                      <div className="md:col-span-2">
                        <label htmlFor="shipping-address" className="block text-sm font-medium mb-2 text-card-foreground">
                          Address
                        </label>
                        <Input
                          id="shipping-address"
                          name="address"
                          type="text"
                          required
                          value={shippingInfo.address}
                          onChange={handleShippingChange}
                          className="text-foreground"
                        />
                      </div>
                      <div>
                        <label htmlFor="shipping-city" className="block text-sm font-medium mb-2 text-card-foreground">
                          City
                        </label>
                        <Input
                          id="shipping-city"
                          name="city"
                          type="text"
                          required
                          value={shippingInfo.city}
                          onChange={handleShippingChange}
                          className="text-foreground"
                        />
                      </div>
                      <div>
                        <label htmlFor="shipping-state" className="block text-sm font-medium mb-2 text-card-foreground">
                          State
                        </label>
                        <Input
                          id="shipping-state"
                          name="state"
                          type="text"
                          required
                          value={shippingInfo.state}
                          onChange={handleShippingChange}
                          className="text-foreground"
                        />
                      </div>
                      <div>
                        <label htmlFor="shipping-zipCode" className="block text-sm font-medium mb-2 text-card-foreground">
                          ZIP Code
                        </label>
                        <Input
                          id="shipping-zipCode"
                          name="zipCode"
                          type="text"
                          required
                          value={shippingInfo.zipCode}
                          onChange={handleShippingChange}
                          className="text-foreground"
                        />
                      </div>
                    </div>
                  </div>

                  <div className="bg-card p-6 rounded-xl shadow-sm">
                    <div className="flex items-center justify-between mb-6">
                      <h2 className="font-display text-2xl font-bold text-card-foreground">Billing Information</h2>
                      <div className="flex items-center gap-2">
                        <Checkbox
                          id="sameAsShipping"
                          checked={sameAsShipping}
                          onCheckedChange={setSameAsShipping}
                        />
                        <label htmlFor="sameAsShipping" className="text-sm font-medium text-card-foreground cursor-pointer">
                          Same as shipping
                        </label>
                      </div>
                    </div>
                    {!sameAsShipping && (
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div className="md:col-span-2">
                          <label htmlFor="billing-fullName" className="block text-sm font-medium mb-2 text-card-foreground">
                            Full Name
                          </label>
                          <Input
                            id="billing-fullName"
                            name="fullName"
                            type="text"
                            required
                            value={billingInfo.fullName}
                            onChange={handleBillingChange}
                            className="text-foreground"
                          />
                        </div>
                        <div className="md:col-span-2">
                          <label htmlFor="billing-address" className="block text-sm font-medium mb-2 text-card-foreground">
                            Address
                          </label>
                          <Input
                            id="billing-address"
                            name="address"
                            type="text"
                            required
                            value={billingInfo.address}
                            onChange={handleBillingChange}
                            className="text-foreground"
                          />
                        </div>
                        <div>
                          <label htmlFor="billing-city" className="block text-sm font-medium mb-2 text-card-foreground">
                            City
                          </label>
                          <Input
                            id="billing-city"
                            name="city"
                            type="text"
                            required
                            value={billingInfo.city}
                            onChange={handleBillingChange}
                            className="text-foreground"
                          />
                        </div>
                        <div>
                          <label htmlFor="billing-state" className="block text-sm font-medium mb-2 text-card-foreground">
                            State
                          </label>
                          <Input
                            id="billing-state"
                            name="state"
                            type="text"
                            required
                            value={billingInfo.state}
                            onChange={handleBillingChange}
                            className="text-foreground"
                          />
                        </div>
                        <div>
                          <label htmlFor="billing-zipCode" className="block text-sm font-medium mb-2 text-card-foreground">
                            ZIP Code
                          </label>
                          <Input
                            id="billing-zipCode"
                            name="zipCode"
                            type="text"
                            required
                            value={billingInfo.zipCode}
                            onChange={handleBillingChange}
                            className="text-foreground"
                          />
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                <div className="lg:col-span-1">
                  <div className="bg-card p-6 rounded-xl shadow-sm sticky top-24">
                    <h2 className="font-display text-2xl font-bold mb-6 text-card-foreground">Order Summary</h2>
                    <div className="space-y-4 mb-6">
                      {cartItems.map((item) => (
                        <div key={item.variant.id} className="flex gap-3">
                          <img
                            src={item.product.image}
                            alt={item.product.title}
                            className="w-16 h-16 object-cover rounded"
                          />
                          <div className="flex-grow">
                            <p className="text-sm font-medium text-card-foreground">{item.product.title}</p>
                            <p className="text-xs text-muted-foreground">{item.variant.title}</p>
                            <p className="text-sm font-semibold text-primary">
                              {item.variant.sale_price_formatted || item.variant.price_formatted} × {item.quantity}
                            </p>
                          </div>
                        </div>
                      ))}
                    </div>
                    <div className="border-t border-border pt-4 space-y-2 mb-6">
                      <div className="flex justify-between text-card-foreground">
                        <span>Subtotal</span>
                        <span className="font-semibold">{getCartTotal()}</span>
                      </div>
                      <div className="flex justify-between text-lg font-bold text-card-foreground">
                        <span>Total</span>
                        <span>{getCartTotal()}</span>
                      </div>
                    </div>
                    <Button
                      type="submit"
                      disabled={isProcessing}
                      className="w-full bg-primary text-primary-foreground hover:bg-primary/90 font-semibold"
                    >
                      {isProcessing ? (
                        <>
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          Processing...
                        </>
                      ) : (
                        'Place Order'
                      )}
                    </Button>
                  </div>
                </div>
              </div>
            </form>
          </div>
        </main>

        <Footer />
      </div>
    </>
  );
};

export default CheckoutPage;