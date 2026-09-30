import React, { useState } from 'react';
import { Helmet } from 'react-helmet';
import Header from '@/components/Header.jsx';
import Footer from '@/components/Footer.jsx';
import ShoppingCart from '@/components/ShoppingCart.jsx';

const ShippingPolicyPage = () => {
  const [isCartOpen, setIsCartOpen] = useState(false);

  return (
    <>
      <Helmet>
        <title>Shipping Policy | FRONTIVA</title>
        <meta name="description" content="Read FRONTIVA's Shipping Policy, including order processing, delivery timelines, shipping charges, tracking, delivery attempts, and shipment support." />
      </Helmet>

      <div className="min-h-screen flex flex-col bg-background">
        <Header setIsCartOpen={setIsCartOpen} />
        <ShoppingCart isCartOpen={isCartOpen} setIsCartOpen={setIsCartOpen} />

        <main className="flex-grow py-16 md:py-24">
          <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="mb-12">
              <h1 className="font-display text-4xl md:text-5xl font-bold mb-4 text-foreground text-balance">
                Shipping Policy
              </h1>
              <p className="text-muted-foreground">Last Updated: September 30, 2026</p>
            </div>

            <div className="space-y-12 text-foreground/90 leading-relaxed">
              <section>
                <p>
                  At FRONTIVA TRADING PRIVATE LIMITED, we are committed to delivering your orders safely, securely, and on time. This Shipping Policy explains how we process and deliver orders placed through the FRONTIVA website.
                </p>
              </section>

              <section>
                <h2 className="font-display text-2xl font-bold mb-4 text-foreground">1. Order Processing</h2>
                <p className="mb-4">
                  Once your order is successfully placed, our team will process and prepare it for dispatch.
                </p>
                <ul className="list-disc pl-6 space-y-2">
                  <li>Orders are generally processed within 1&ndash;3 business days.</li>
                  <li>Orders placed on weekends or public holidays may be processed on the next business day.</li>
                  <li>Once your order has been dispatched, you will receive shipping or tracking information where applicable.</li>
                  <li>Processing times may occasionally be longer during sales, promotional periods, holidays, or due to circumstances beyond our control.</li>
                </ul>
              </section>

              <section>
                <h2 className="font-display text-2xl font-bold mb-4 text-foreground">2. Shipping &amp; Delivery Time</h2>
                <p className="mb-4">We currently deliver orders within India.</p>
                <p className="mb-4">
                  After dispatch, delivery generally takes approximately 3&ndash;7 business days, depending on your location and the availability of courier services in your area.
                </p>
                <p className="mb-4">Delivery times are estimates and may vary because of:</p>
                <ul className="list-disc pl-6 space-y-2 mb-4">
                  <li>Your delivery location</li>
                  <li>Courier service availability</li>
                  <li>Weather conditions</li>
                  <li>Public holidays</li>
                  <li>Natural disasters or other unforeseen circumstances</li>
                  <li>High order volumes</li>
                  <li>Other circumstances beyond our reasonable control</li>
                </ul>
                <p>Remote and difficult-to-service locations may require additional delivery time.</p>
              </section>

              <section>
                <h2 className="font-display text-2xl font-bold mb-4 text-foreground">3. Shipping Charges</h2>
                <p className="mb-4">
                  Applicable shipping charges, if any, will be displayed during the checkout process before you complete your purchase.
                </p>
                <p>
                  Any promotional free-shipping offers will be subject to the terms and conditions mentioned with the respective offer.
                </p>
              </section>

              <section>
                <h2 className="font-display text-2xl font-bold mb-4 text-foreground">4. Order Tracking</h2>
                <p className="mb-4">
                  Once your order has been dispatched, tracking details may be provided to you through the contact information submitted during checkout.
                </p>
                <p className="mb-4">
                  You can use the tracking information provided by the courier partner to check the status of your shipment.
                </p>
                <p>
                  Please allow some time for tracking information to become active after the order has been dispatched.
                </p>
              </section>

              <section>
                <h2 className="font-display text-2xl font-bold mb-4 text-foreground">5. Incorrect or Incomplete Address</h2>
                <p className="mb-4">
                  Customers are responsible for providing a complete and accurate delivery address, including:
                </p>
                <ul className="list-disc pl-6 space-y-2 mb-4">
                  <li>Full name</li>
                  <li>House/flat number</li>
                  <li>Street/locality</li>
                  <li>City</li>
                  <li>State</li>
                  <li>PIN code</li>
                  <li>Valid contact number</li>
                </ul>
                <p className="mb-4">
                  FRONTIVA will not be responsible for delays, failed deliveries, or additional charges resulting from an incorrect, incomplete, or inaccurate shipping address provided by the customer.
                </p>
                <p>
                  If an order is returned to us because of an incorrect or incomplete address, re-shipping may be subject to additional shipping charges.
                </p>
              </section>

              <section>
                <h2 className="font-display text-2xl font-bold mb-4 text-foreground">6. Delayed Delivery</h2>
                <p className="mb-4">
                  Although we make reasonable efforts to deliver orders within the estimated delivery period, FRONTIVA cannot guarantee delivery on a specific date.
                </p>
                <p>
                  If your order is delayed beyond the estimated delivery period, please contact our customer support team with your order details so that we can assist you.
                </p>
              </section>

              <section>
                <h2 className="font-display text-2xl font-bold mb-4 text-foreground">7. Lost or Damaged Packages</h2>
                <p className="mb-4">
                  If you receive a package that appears to be damaged or tampered with, please contact us as soon as possible.
                </p>
                <p className="mb-4">Where possible, customers are advised to:</p>
                <ul className="list-disc pl-6 space-y-2 mb-4">
                  <li>Take photographs or videos of the package before opening it.</li>
                  <li>Keep the original packaging and shipping label.</li>
                  <li>Contact us with your order number and relevant photographs/videos.</li>
                </ul>
                <p>
                  We will review the matter and coordinate with the relevant courier partner where necessary.
                </p>
              </section>

              <section>
                <h2 className="font-display text-2xl font-bold mb-4 text-foreground">8. Delivery Attempts</h2>
                <p className="mb-4">
                  Our courier partner may make multiple delivery attempts before returning an undelivered package to the sender.
                </p>
                <p className="mb-4">
                  Please ensure that you or an authorized person is available to receive the order at the provided delivery address.
                </p>
                <p>
                  If the package is returned because of repeated unsuccessful delivery attempts or refusal to accept the shipment, additional shipping charges may apply for re-delivery.
                </p>
              </section>

              <section>
                <h2 className="font-display text-2xl font-bold mb-4 text-foreground">9. Delivery to Remote Locations</h2>
                <p className="mb-4">
                  Orders placed for remote, rural, or difficult-to-service locations may require additional delivery time.
                </p>
                <p>
                  In certain locations where standard courier delivery is unavailable, we may contact you regarding alternative delivery arrangements.
                </p>
              </section>

              <section>
                <h2 className="font-display text-2xl font-bold mb-4 text-foreground">10. Changes to Shipping Information</h2>
                <p className="mb-4">
                  If you need to change your delivery address after placing an order, please contact us as soon as possible.
                </p>
                <p>
                  We will try to accommodate address changes before the order is dispatched. However, once an order has been shipped, we may not be able to change the delivery address.
                </p>
              </section>

              <section>
                <h2 className="font-display text-2xl font-bold mb-4 text-foreground">11. International Shipping</h2>
                <p className="mb-4">
                  Unless specifically stated otherwise on the website, FRONTIVA currently offers shipping within India only.
                </p>
                <p>International orders are not currently supported.</p>
              </section>

              <section>
                <h2 className="font-display text-2xl font-bold mb-4 text-foreground">12. Contact Us</h2>
                <p className="mb-4">
                  If you have any questions regarding your shipment or delivery, please contact us:
                </p>
                <div className="bg-muted p-8 rounded-2xl border border-border/50 mt-6 space-y-4">
                  <p className="font-semibold text-xl text-foreground">FRONTIVA TRADING PRIVATE LIMITED</p>
                  <div className="flex flex-col sm:flex-row sm:gap-2">
                    <span className="font-medium text-foreground min-w-[80px] shrink-0 mt-0.5">Address:</span>
                    <address className="not-italic text-muted-foreground leading-relaxed">
                      SHOP NO-3 DDA MARKET CSC,<br />
                      JAGITRI ENCLAVE SHAHDARA,<br />
                      New Delhi, Delhi, India &ndash; 110092
                    </address>
                  </div>
                  <p className="flex flex-col sm:flex-row sm:gap-2">
                    <span className="font-medium text-foreground min-w-[80px]">Email:</span>
                    <a href="mailto:frontivatrading@gmail.com" className="text-primary hover:underline break-all">frontivatrading@gmail.com</a>
                  </p>
                  <p className="flex flex-col sm:flex-row sm:gap-2">
                    <span className="font-medium text-foreground min-w-[80px]">Phone:</span>
                    <a href="tel:7840873009" className="text-muted-foreground hover:text-primary transition-colors">7840873009</a>
                  </p>
                </div>
                <p className="mt-6">
                  Please include your order number when contacting us regarding an existing order so that we can assist you more efficiently.
                </p>
              </section>
            </div>
          </div>
        </main>

        <Footer />
      </div>
    </>
  );
};

export default ShippingPolicyPage;
