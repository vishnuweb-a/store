import React, { useEffect, useState } from 'react';
import { Helmet } from 'react-helmet';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import { QRCodeSVG } from 'qrcode.react';
import { AlertCircle, ArrowRight, Banknote, CheckCircle, Clock, CreditCard, Loader2, MapPin, Phone, QrCode, Smartphone, User } from 'lucide-react';
import { Button } from '@/components/ui/button';
import Header from '@/components/Header';
import Footer from '@/components/Footer';
import ShoppingCart from '@/components/ShoppingCart';
import { useCart } from '@/hooks/useCart';
import { useIsMobile } from '@/hooks/use-mobile';
import { FRONTIVA_PAYIN_GATEWAY, getLatestOrder, getOnlineOrder, isUpiPayIntent } from '@/api/OrdersApi';

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

/**
 * SabPaisa has no callback here, so a returning customer's page asks the server
 * again a few times while the payment is unresolved. Bounded, and the server
 * throttles the enquiries behind it regardless.
 */
const SABPAISA_POLL_INTERVAL_MS = 10_000;
const SABPAISA_MAX_POLLS = 6;
const POLLABLE_STATUSES = new Set(['initiated', 'processing']);

/**
 * A QR customer still has to scan and pay, so the page polls longer (5 min).
 * Bounded; afterwards "Check payment status" asks again, and the server
 * throttles and reconciles regardless.
 */
const PAYIN_MAX_POLLS = 30;

/** Mirrors FRONTIVA_QR_VALID_MS on the server: a QR is not offered as payable indefinitely. */
const PAYIN_QR_VALID_MS = 30 * 60_000;

const PAYIN_QR_VIEW = {
  title: 'Scan to Pay',
  heading: 'Scan to Pay',
  message: 'Scan the QR code with any UPI app to pay. This page updates once your payment is confirmed.',
  Icon: QrCode,
  tone: 'bg-amber-100 text-amber-600',
  settled: false,
};

const SuccessPage = () => {
  const [isCartOpen, setIsCartOpen] = useState(false);
  const { clearCart } = useCart();
  const location = useLocation();
  const [searchParams] = useSearchParams();

  // Present only when a payment gateway has just returned the customer to the
  // site. SabPaisa appends its own parameters to the return URL; should they
  // ever be joined with a second `?` they would run into `ref`, so only the
  // leading order reference is kept. The server looks it up and decides —
  // none of SabPaisa's appended parameters are read.
  const paymentRef = searchParams.get('ref')?.match(/^FRV[A-Z0-9]{5,61}/)?.[0] ?? searchParams.get('ref');

  // Frontiva PayIn only: proves this browser started the checkout, so the server may restore its QR.
  const attemptKey = searchParams.get('k');

  const [onlineOrder, setOnlineOrder] = useState(null);
  const [isLoadingPayment, setIsLoadingPayment] = useState(Boolean(paymentRef));
  const [paymentError, setPaymentError] = useState(null);
  const [pollCount, setPollCount] = useState(0);
  const [isChecking, setIsChecking] = useState(false);
  const isMobile = useIsMobile();

  const order = paymentRef ? onlineOrder : location.state?.order || getLatestOrder();

  // payment_status is the authoritative online state; status mirrors it.
  const paymentStatus = onlineOrder?.payment_status || onlineOrder?.status;

  const isPayin = onlineOrder?.payment_gateway === FRONTIVA_PAYIN_GATEWAY;
  // Frontiva PayIn: the server's stored intent (survives a refresh), else the one
  // checkout just handed over. Never re-created here; shown only while payable.
  const qrFresh = Boolean(onlineOrder?.created_at) && Date.now() - Date.parse(onlineOrder.created_at) <= PAYIN_QR_VALID_MS;
  const stateIntent = qrFresh && isUpiPayIntent(location.state?.payinIntent) ? location.state.payinIntent : null;
  const payinIntent =
    isPayin && POLLABLE_STATUSES.has(paymentStatus) ? onlineOrder.payment_intent || stateIntent : null;

  const onlineView = paymentRef ? ONLINE_STATUS_VIEWS[paymentStatus] || PENDING_VIEW : null;
  // payinIntent exists only for a loaded online order, so COD never sees it.
  const statusView = payinIntent ? PAYIN_QR_VIEW : onlineView;

  // A verification request only: it reads the server's verified status and never creates a payment.
  const checkNow = () => {
    setIsChecking(true);
    getOnlineOrder(paymentRef, attemptKey)
      .then((loaded) => {
        setOnlineOrder(loaded);
        setPaymentError(null);
      })
      .catch(() => {
        // Not an answer; the order stays as last verified.
      })
      .finally(() => {
        setIsChecking(false);
        setPollCount(0);
      });
  };

  useEffect(() => {
    if (!paymentRef) {
      return;
    }

    let cancelled = false;

    getOnlineOrder(paymentRef, attemptKey)
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
  }, [paymentRef, attemptKey]);

  const shouldPoll =
    // Gateways with no callback: the page asks the server to check again.
    ['sabpaisa', 'frontiva_payin'].includes(onlineOrder?.payment_gateway) &&
    POLLABLE_STATUSES.has(paymentStatus) &&
    pollCount < (isPayin ? PAYIN_MAX_POLLS : SABPAISA_MAX_POLLS) &&
    !isChecking &&
    !paymentError;

  useEffect(() => {
    if (!shouldPoll) {
      return;
    }

    let cancelled = false;

    const timer = setTimeout(() => {
      getOnlineOrder(paymentRef, attemptKey)
        .then((loaded) => {
          if (!cancelled) {
            setOnlineOrder(loaded);
          }
        })
        .catch(() => {
          // A failed poll is not an answer; the next one, or Refresh, will try again.
        })
        .finally(() => {
          if (!cancelled) {
            setPollCount((count) => count + 1);
          }
        });
    }, SABPAISA_POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [shouldPoll, paymentRef, attemptKey, pollCount]);

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

            {payinIntent && order && (
              <motion.div
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.4, delay: 0.15 }}
                className="bg-card p-6 sm:p-8 rounded-xl shadow-sm mb-8 text-center"
              >
                <h2 className="font-display text-xl font-bold mb-4 text-card-foreground">Pay with UPI</h2>
                <p className="font-semibold text-sm text-muted-foreground mb-1">Amount to pay</p>
                <p className="text-3xl font-bold text-card-foreground mb-6">{order.total_formatted}</p>

                {/* The QR is the validated provider intent, byte-for-byte. White quiet zone for scanners. */}
                <div className="mx-auto w-full max-w-[320px] bg-white p-4 rounded-lg mb-4">
                  <QRCodeSVG
                    value={payinIntent}
                    size={320}
                    level="M"
                    marginSize={4}
                    bgColor="#ffffff"
                    fgColor="#000000"
                    className="w-full h-auto"
                    role="img"
                    aria-label={`UPI QR code to pay ${order.total_formatted}`}
                  />
                </div>

                <p className="text-sm text-muted-foreground mb-6">
                  Check that your UPI app shows <span className="font-semibold text-card-foreground">{order.total_formatted}</span> to
                  Frontiva Trading Private Limited before you pay.
                </p>

                {isMobile && (
                  <Button
                    asChild
                    size="lg"
                    className="bg-primary text-primary-foreground hover:bg-primary/90 font-semibold w-full sm:w-auto mb-6"
                  >
                    <a href={payinIntent} aria-label={`Open your UPI app to pay ${order.total_formatted}`}>
                      <Smartphone className="mr-2 h-5 w-5" aria-hidden="true" />
                      Open UPI App
                    </a>
                  </Button>
                )}

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 text-left border-t border-border pt-6">
                  <div>
                    <h3 className="font-semibold text-sm text-muted-foreground mb-1">Order Reference</h3>
                    <p className="text-lg font-bold text-card-foreground break-all">{order.order_ref}</p>
                  </div>
                  <div>
                    <h3 className="font-semibold text-sm text-muted-foreground mb-1">Payment Status</h3>
                    <p className="text-lg font-bold text-amber-600 inline-flex items-center gap-2" aria-live="polite">
                      <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
                      {isChecking ? 'Verifying…' : 'Waiting for payment'}
                    </p>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground mt-4 text-left">
                  Scanning the code does not complete your order. It is confirmed only after we verify the payment with our
                  payment partner.
                </p>
              </motion.div>
            )}

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
              {statusView && !statusView.settled && !paymentError && isPayin && (
                <Button size="lg" variant="outline" onClick={checkNow} disabled={isChecking} className="w-full sm:w-auto">
                  {isChecking && <Loader2 className="mr-2 h-5 w-5 animate-spin" aria-hidden="true" />}
                  Check Payment Status
                </Button>
              )}
              {statusView && !statusView.settled && !paymentError && !isPayin && (
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
