import React, { useEffect, useRef, useState } from 'react';
import { Helmet } from 'react-helmet';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Banknote, CheckCircle2, CreditCard, Loader2, MapPin, Phone, User } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useCart } from '@/hooks/useCart';
import { useToast } from '@/hooks/use-toast';
import { formatCurrency } from '@/api/EcommerceApi';
import { createCodOrder, createOnlinePayment, submitPayment } from '@/api/OrdersApi';
import Header from '@/components/Header';
import Footer from '@/components/Footer';
import ShoppingCart from '@/components/ShoppingCart';

const PAYMENT_METHODS = [
  {
    id: 'cod',
    label: 'Cash on Delivery',
    description: 'Pay in cash when your order is delivered',
    Icon: Banknote,
  },
  {
    id: 'online',
    label: 'Pay Online',
    description: 'Pay securely by UPI, card, net banking or wallet',
    Icon: CreditCard,
  },
];

const CheckoutPage = () => {
  const [isCartOpen, setIsCartOpen] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState('cod');
  const [errors, setErrors] = useState({});
  const orderPlacedRef = useRef(false);
  const { cartItems, clearCart } = useCart();
  const { toast } = useToast();
  const navigate = useNavigate();

  const [customerInfo, setCustomerInfo] = useState({
    fullName: '',
    phone: '',
    address: '',
    landmark: '',
  });

  useEffect(() => {
    if (cartItems.length === 0 && !orderPlacedRef.current) {
      navigate('/cart');
    }
  }, [cartItems, navigate]);

  const currencyInfo = cartItems[0]?.variant.currency_info;
  const totalInCents = cartItems.reduce((total, item) => {
    const price = item.variant.sale_price_in_cents ?? item.variant.price_in_cents;
    return total + price * item.quantity;
  }, 0);
  const totalFormatted = formatCurrency(totalInCents, currencyInfo);
  const isOnline = paymentMethod === 'online';
  const selectedMethod = PAYMENT_METHODS.find((method) => method.id === paymentMethod) ?? PAYMENT_METHODS[0];

  const validate = () => {
    const nextErrors = {};

    if (!customerInfo.fullName.trim()) {
      nextErrors.fullName = 'Full name is required.';
    } else if (customerInfo.fullName.trim().length < 3) {
      nextErrors.fullName = 'Name must be at least 3 characters.';
    }

    if (!customerInfo.phone) {
      nextErrors.phone = 'Phone number is required.';
    } else if (!/^\d{10}$/.test(customerInfo.phone)) {
      nextErrors.phone = 'Enter a valid 10-digit phone number.';
    }

    if (!customerInfo.address.trim()) {
      nextErrors.address = 'Delivery address is required.';
    }

    return nextErrors;
  };

  const handleChange = (e) => {
    const { name, value } = e.target;
    const nextValue = name === 'phone' ? value.replace(/\D/g, '').slice(0, 10) : value;

    setCustomerInfo((prev) => ({ ...prev, [name]: nextValue }));
    setErrors((prev) => {
      if (!prev[name]) return prev;
      const { [name]: _removed, ...rest } = prev;
      return rest;
    });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();

    const nextErrors = validate();
    if (Object.keys(nextErrors).length > 0) {
      setErrors(nextErrors);
      return;
    }

    // Guards against a double submit while a request or redirect is in flight.
    if (isProcessing) {
      return;
    }

    setIsProcessing(true);

    if (paymentMethod === 'online') {
      try {
        const payment = await createOnlinePayment({ customer: customerInfo, cartItems });

        // The cart is deliberately left intact: the payment can still fail or
        // be abandoned, and the customer should come back to a full cart.
        // /success clears it once the payment is confirmed.
        submitPayment(payment);
      } catch (error) {
        toast({
          title: 'Could not start online payment',
          description:
            error.message || 'There was a problem reaching the payment gateway. Please try again.',
          variant: 'destructive',
        });
        setIsProcessing(false);
      }

      return;
    }

    try {
      const order = await createCodOrder({ customer: customerInfo, cartItems });

      orderPlacedRef.current = true;
      clearCart();
      navigate('/success', { state: { order }, replace: true });
    } catch (error) {
      toast({
        title: 'Could not place order',
        description: error.message || 'There was a problem placing your order. Please try again.',
        variant: 'destructive',
      });
      setIsProcessing(false);
    }
  };

  if (cartItems.length === 0) {
    return null;
  }

  const fieldError = (name) =>
    errors[name] ? (
      <p className="mt-2 text-sm text-destructive" role="alert">
        {errors[name]}
      </p>
    ) : null;

  return (
    <>
      <Helmet>
        <title>Checkout - FRONTIVA</title>
        <meta name="description" content="Complete your order with Cash on Delivery or pay online." />
      </Helmet>

      <div className="min-h-screen flex flex-col">
        <Header setIsCartOpen={setIsCartOpen} />
        <ShoppingCart isCartOpen={isCartOpen} setIsCartOpen={setIsCartOpen} />

        <main className="flex-grow py-12">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <motion.div
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4 }}
              className="mb-8"
            >
              <h1 className="font-display text-4xl md:text-5xl font-bold mb-4 text-foreground">Checkout</h1>
              <p className="text-lg text-muted-foreground">Enter your delivery details to place your order</p>
            </motion.div>

            <form onSubmit={handleSubmit} noValidate>
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                <div className="lg:col-span-2 space-y-8">
                  <motion.div
                    initial={{ opacity: 0, y: 12 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.4, delay: 0.1 }}
                    className="bg-card p-6 rounded-xl shadow-sm"
                  >
                    <h2 className="font-display text-2xl font-bold mb-6 text-card-foreground">Delivery Information</h2>
                    <div className="space-y-4">
                      <div>
                        <label htmlFor="fullName" className="block text-sm font-medium mb-2 text-card-foreground">
                          <User className="inline h-4 w-4 mr-1 text-muted-foreground" aria-hidden="true" />
                          Full Name <span className="text-destructive">*</span>
                        </label>
                        <Input
                          id="fullName"
                          name="fullName"
                          type="text"
                          autoComplete="name"
                          placeholder="Your full name"
                          value={customerInfo.fullName}
                          onChange={handleChange}
                          aria-invalid={Boolean(errors.fullName)}
                          className="text-foreground h-11"
                        />
                        {fieldError('fullName')}
                      </div>
                      <div>
                        <label htmlFor="phone" className="block text-sm font-medium mb-2 text-card-foreground">
                          <Phone className="inline h-4 w-4 mr-1 text-muted-foreground" aria-hidden="true" />
                          Phone Number <span className="text-destructive">*</span>
                        </label>
                        <Input
                          id="phone"
                          name="phone"
                          type="tel"
                          inputMode="numeric"
                          autoComplete="tel"
                          placeholder="10-digit mobile number"
                          value={customerInfo.phone}
                          onChange={handleChange}
                          aria-invalid={Boolean(errors.phone)}
                          className="text-foreground h-11"
                        />
                        {fieldError('phone')}
                      </div>
                      <div>
                        <label htmlFor="address" className="block text-sm font-medium mb-2 text-card-foreground">
                          <MapPin className="inline h-4 w-4 mr-1 text-muted-foreground" aria-hidden="true" />
                          Full Address <span className="text-destructive">*</span>
                        </label>
                        <Textarea
                          id="address"
                          name="address"
                          rows={3}
                          autoComplete="street-address"
                          placeholder="House / flat, street, area, city, state, PIN code"
                          value={customerInfo.address}
                          onChange={handleChange}
                          aria-invalid={Boolean(errors.address)}
                          className="text-foreground"
                        />
                        {fieldError('address')}
                      </div>
                      <div>
                        <label htmlFor="landmark" className="block text-sm font-medium mb-2 text-card-foreground">
                          Landmark <span className="text-muted-foreground font-normal">(optional)</span>
                        </label>
                        <Input
                          id="landmark"
                          name="landmark"
                          type="text"
                          placeholder="Nearby landmark to help delivery"
                          value={customerInfo.landmark}
                          onChange={handleChange}
                          className="text-foreground h-11"
                        />
                      </div>
                    </div>
                  </motion.div>

                  <motion.div
                    initial={{ opacity: 0, y: 12 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.4, delay: 0.2 }}
                    className="bg-card p-6 rounded-xl shadow-sm"
                  >
                    <h2 className="font-display text-2xl font-bold mb-6 text-card-foreground">Payment Method</h2>
                    <div className="space-y-3" role="radiogroup" aria-label="Payment method">
                      {PAYMENT_METHODS.map(({ id, label, description, Icon }) => {
                        const isSelected = paymentMethod === id;

                        return (
                          <button
                            key={id}
                            type="button"
                            role="radio"
                            aria-checked={isSelected}
                            onClick={() => setPaymentMethod(id)}
                            className={`w-full text-left flex items-center gap-4 p-4 rounded-lg border-2 transition-colors ${
                              isSelected ? 'border-primary bg-accent/50' : 'border-border hover:bg-muted'
                            }`}
                          >
                            <div className="bg-primary/10 p-3 rounded-lg">
                              <Icon className="h-6 w-6 text-primary" aria-hidden="true" />
                            </div>
                            <div className="flex-grow">
                              <p className="font-semibold text-card-foreground">{label}</p>
                              <p className="text-sm text-muted-foreground">{description}</p>
                            </div>
                            {isSelected && (
                              <CheckCircle2 className="h-6 w-6 text-primary shrink-0" aria-hidden="true" />
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </motion.div>
                </div>

                <div className="lg:col-span-1">
                  <motion.div
                    initial={{ opacity: 0, y: 12 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.4, delay: 0.3 }}
                    className="bg-card p-6 rounded-xl shadow-sm sticky top-24"
                  >
                    <h2 className="font-display text-2xl font-bold mb-6 text-card-foreground">Order Summary</h2>
                    <div className="space-y-4 mb-6">
                      {cartItems.map((item) => {
                        const unitPrice = item.variant.sale_price_in_cents ?? item.variant.price_in_cents;
                        return (
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
                            <p className="text-sm font-semibold text-card-foreground whitespace-nowrap">
                              {formatCurrency(unitPrice * item.quantity, currencyInfo)}
                            </p>
                          </div>
                        );
                      })}
                    </div>
                    <div className="border-t border-border pt-4 space-y-2 mb-6">
                      <div className="flex justify-between text-card-foreground">
                        <span>Subtotal</span>
                        <span className="font-semibold">{totalFormatted}</span>
                      </div>
                      <div className="flex justify-between text-card-foreground">
                        <span>Payment</span>
                        <span className="text-muted-foreground">{selectedMethod.label}</span>
                      </div>
                      <div className="flex justify-between text-lg font-bold text-card-foreground">
                        <span>Total</span>
                        <span>{totalFormatted}</span>
                      </div>
                    </div>
                    <Button
                      type="submit"
                      disabled={isProcessing}
                      className="w-full h-12 bg-primary text-primary-foreground hover:bg-primary/90 font-semibold text-base"
                    >
                      {isProcessing ? (
                        <>
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          {isOnline ? 'Redirecting to payment...' : 'Placing Order...'}
                        </>
                      ) : isOnline ? (
                        `Pay ${totalFormatted}`
                      ) : (
                        'Confirm Order'
                      )}
                    </Button>
                    <p className="mt-3 text-xs text-center text-muted-foreground">
                      {isOnline
                        ? `You will be taken to our secure payment partner to pay ${totalFormatted}.`
                        : `No advance payment required — pay ${totalFormatted} on delivery.`}
                    </p>
                  </motion.div>
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
