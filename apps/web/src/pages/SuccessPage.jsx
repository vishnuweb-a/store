import React, { useEffect, useState } from 'react';
import { Helmet } from 'react-helmet';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import { AlertCircle, ArrowRight, Banknote, CheckCircle, Clock, CreditCard, Loader2, MapPin, Phone, User } from 'lucide-react';
import { Button } from '@/components/ui/button';
import Header from '@/components/Header';
import Footer from '@/components/Footer';
import ShoppingCart from '@/components/ShoppingCart';
import { useCart } from '@/hooks/useCart';
import { getLatestOrder, getOnlineOrder } from '@/api/OrdersApi';

/**
 * How an online order's status is presented. COD orders never reach this map —
 * they keep the original unconditional "Thank You!" confirmation.
 */
const ONLINE_STATUS_VIEWS = {
  paid: {
    title: 'Order Confirmed',
    heading: 'Thank You!',
    message: 'Your payment was successful and your order has been placed.',
    Icon: CheckCircle,
    tone: 'bg-green-100 text-green-600',
    settled: true,
  },
  failed: {
    title: 'Payment Not Completed',
    heading: 'Payment Not Completed',
    message: 'Your payment did not go through, so no order was placed. Your cart is still saved.',
    Icon: AlertCircle,
    tone: 'bg-red-100 text-red-600',
    settled: true,
  },
  processing: {
    title: 'Payment Status',
    heading: 'Payment Still Processing',
    message:
      'Your bank has not finished confirming this payment yet. We will keep checking and update your order automatically.',
    Icon: Clock,
    tone: 'bg-amber-100 text-amber-600',
    settled: false,
  },
  initiated: {
    title: 'Payment Status',
    heading: 'Confirming Your Payment',
    message: 'We are checking this payment with our payment partner. This usually takes a few seconds.',
    Icon: Clock,
    tone: 'bg-amber-100 text-amber-600',
    settled: false,
  },
  requires_review: {
    title: 'Payment Status',
    heading: 'Payment Being Verified',
    message:
      'We could not automatically confirm this payment, so our team is reviewing it. You have not been charged twice, and we will contact you shortly.',
    Icon: Clock,
    tone: 'bg-amber-100 text-amber-600',
    settled: false,
  },
};

const PENDING_VIEW = {
  title: 'Payment Status',
  heading: 'Confirming Your Payment',
  message: 'This usually takes a few seconds. Please do not close this page.',
  Icon: Clock,
  tone: 'bg-amber-100 text-amber-600',
  settled: false,
};

const SuccessPage = () => {
  const [isCartOpen, setIsCartOpen] = useState(false);
  const { clearCart } = useCart();
  const location = useLocation();
  const [searchParams] = useSearchParams();

  // Present only when Airpay has just returned the customer to the site.
  const paymentRef = searchParams.get('ref');

  const [onlineOrder, setOnlineOrder] = useState(null);
  const [isLoadingPayment, setIsLoadingPayment] = useState(Boolean(paymentRef));
  const [paymentError, setPaymentError] = useState(null);

  const order = paymentRef ? onlineOrder : location.state?.order || getLatestOrder();

  // payment_status is the authoritative online state; status mirrors it.
  const paymentStatus = onlineOrder?.payment_status || onlineOrder?.status;

  const statusView = paymentRef ? ONLINE_STATUS_VIEWS[paymentStatus] || PENDING_VIEW : null;

  useEffect(() => {
    if (!paymentRef) {
      return;
    }

    let cancelled = false;

    getOnlineOrder(paymentRef)
      .then((loaded) => {
        if (!cancelled) {
          setOnlineOrder(loaded);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setPaymentError(error.message || 'We could not load your order.');
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoadingPayment(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [paymentRef]);

  useEffect(() => {
    // A failed or still-unconfirmed online payment must keep the cart, so the
    // customer can retry without rebuilding it. Every other case clears it,
    // exactly as before.
    if (paymentRef && paymentStatus !== 'paid') {
      return;
    }

    clearCart();
  }, [clearCart, paymentRef, paymentStatus]);

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
        <title>{(statusView?.title || 'Order Confirmed')} - FRONTIVA</title>
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
                className={`inline-flex items-center justify-center w-24 h-24 rounded-full mb-6 ${
                  statusView ? statusView.tone : 'bg-green-100 text-green-600'
                }`}
              >
                {isLoadingPayment ? (
                  <Loader2 className="h-14 w-14 animate-spin" aria-hidden="true" />
                ) : (
                  React.createElement(statusView ? statusView.Icon : CheckCircle, {
                    className: 'h-14 w-14',
                    'aria-hidden': 'true',
                  })
                )}
              </motion.div>
              <h1 className="font-display text-4xl md:text-5xl font-bold mb-4 text-foreground" aria-live="polite">
                {isLoadingPayment ? PENDING_VIEW.heading : statusView ? statusView.heading : 'Thank You!'}
              </h1>
              <p className="text-lg text-muted-foreground">
                {paymentError
                  ? paymentError
                  : isLoadingPayment
                    ? PENDING_VIEW.message
                    : statusView
                      ? statusView.message
                      : 'Your order has been placed successfully.'}
              </p>
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
                      {order.payment_method === 'Online Payment' ? (
                        <CreditCard className="h-5 w-5 text-primary" aria-hidden="true" />
                      ) : (
                        <Banknote className="h-5 w-5 text-primary" aria-hidden="true" />
                      )}
                      {order.payment_method || 'Cash on Delivery'}
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
                          {item.size && <p className="text-xs text-muted-foreground">Size: {item.size}</p>}
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
              {statusView && !statusView.settled && !paymentError && (
                <Button
                  size="lg"
                  variant="outline"
                  onClick={() => window.location.reload()}
                  className="w-full sm:w-auto"
                >
                  Refresh Status
                </Button>
              )}
              {paymentStatus === 'failed' && (
                <Link to="/checkout">
                  <Button size="lg" className="bg-primary text-primary-foreground hover:bg-primary/90 font-semibold w-full sm:w-auto">
                    Try Again
                  </Button>
                </Link>
              )}
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
