import React, { useState } from 'react';
import { Helmet } from 'react-helmet';
import Header from '@/components/Header.jsx';
import Footer from '@/components/Footer.jsx';
import ShoppingCart from '@/components/ShoppingCart.jsx';

const RefundPolicyPage = () => {
  const [isCartOpen, setIsCartOpen] = useState(false);

  return (
    <>
      <Helmet>
        <title>Refund & Cancellation Policy - FRONTIVA</title>
        <meta name="description" content="Read FRONTIVA TRADING PRIVATE LIMITED's comprehensive Refund & Cancellation Policy, including return eligibility, process, and processing times." />
      </Helmet>

      <div className="min-h-screen flex flex-col bg-background">
        <Header setIsCartOpen={setIsCartOpen} />
        <ShoppingCart isCartOpen={isCartOpen} setIsCartOpen={setIsCartOpen} />

        <main className="flex-grow py-16 md:py-24">
          <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="mb-12">
              <h1 className="font-display text-4xl md:text-5xl font-bold mb-4 text-foreground text-balance">
                Refund & Cancellation Policy
              </h1>
              <p className="text-muted-foreground">Last updated: July 10, 2026</p>
            </div>

            <div className="space-y-12 text-foreground/90 leading-relaxed">
              <section>
                <h2 className="font-display text-2xl font-bold mb-4 text-foreground">1. Order Cancellation</h2>
                <h3 className="text-xl font-semibold mb-2 text-foreground">Before Shipment:</h3>
                <p className="mb-4">
                  You may cancel your order at any time before it has been processed and shipped. To cancel, please contact us immediately. If the cancellation is successful, we will issue a full refund to your original payment method.
                </p>
                <h3 className="text-xl font-semibold mb-2 text-foreground">After Shipment:</h3>
                <p>
                  Once an order has been shipped, it cannot be canceled. You will need to receive the package and follow our standard return process detailed below.
                </p>
              </section>

              <section>
                <h2 className="font-display text-2xl font-bold mb-4 text-foreground">2. Return Eligibility</h2>
                <p className="mb-4">
                  We accept returns within 7 days of the delivery date. To be eligible for a return, the item must meet the following conditions:
                </p>
                <ul className="list-disc pl-6 space-y-2">
                  <li>The product is unused, unworn, unwashed, and in the exact condition you received it.</li>
                  <li>All original tags, labels, and packaging must be intact and securely attached.</li>
                  <li>A valid proof of purchase (order confirmation or receipt) must be provided.</li>
                </ul>
              </section>

              <section>
                <h2 className="font-display text-2xl font-bold mb-4 text-foreground">3. Non-Returnable Items</h2>
                <p className="mb-4">For hygiene and safety reasons, the following items cannot be returned or refunded:</p>
                <ul className="list-disc pl-6 space-y-2">
                  <li>Underwear, intimate apparel, and swimwear.</li>
                  <li>Custom-made, personalized, or altered items.</li>
                  <li>Items marked as "Final Sale" or purchased during specific promotional clearance events.</li>
                  <li>Gift cards.</li>
                </ul>
              </section>

              <section>
                <h2 className="font-display text-2xl font-bold mb-4 text-foreground">4. Refund Policy</h2>
                <p>
                  Once your return is received and inspected at our facility, we will notify you of the approval or rejection of your refund. If approved, your refund will be processed and automatically applied to your original method of payment. Original shipping costs are non-refundable, and if you receive a refund, the cost of return shipping (if a prepaid label was provided) may be deducted from your refund.
                </p>
              </section>

              <section>
                <h2 className="font-display text-2xl font-bold mb-4 text-foreground">5. Exchange Policy</h2>
                <p>
                  We only replace items if they are defective, damaged, or if you received the incorrect size/color due to our error. If you need to exchange a defective or incorrect item for the same product, please contact our support team. Exchanges are subject to product availability. If the item is out of stock, a refund will be issued instead.
                </p>
              </section>

              <section>
                <h2 className="font-display text-2xl font-bold mb-4 text-foreground">6. Damaged or Incorrect Products</h2>
                <p>
                  If you receive a product that is damaged during transit or incorrect, you must report it to us within 48 hours of delivery. Please provide clear photographic evidence of the damage or incorrect item along with your order details. We will arrange for a replacement or a full refund at no additional cost to you.
                </p>
              </section>

              <section>
                <h2 className="font-display text-2xl font-bold mb-4 text-foreground">7. Refund Processing Time</h2>
                <ul className="list-disc pl-6 space-y-2">
                  <li><strong>Initiation:</strong> We strive to process returns and initiate refunds within 2-5 business days of receiving the returned item.</li>
                  <li><strong>Bank Processing:</strong> Depending on your bank or credit card company, it may take an additional 5-10 business days for the funds to officially post to your account.</li>
                </ul>
              </section>

              <section>
                <h2 className="font-display text-2xl font-bold mb-4 text-foreground">8. How to Request a Return or Refund</h2>
                <p className="mb-4">To initiate a return, please follow these steps:</p>
                <ol className="list-decimal pl-6 space-y-2">
                  <li>Contact our customer support team at <a href="mailto:frontivatrading@gmail.com" className="text-primary hover:underline">frontivatrading@gmail.com</a> with your order number and reason for return.</li>
                  <li>Wait for our team to approve the request and provide you with return instructions and a Return Merchandise Authorization (RMA) number.</li>
                  <li>Securely pack the item(s) in the original packaging, including all tags and documentation.</li>
                  <li>Ship the package to the address provided by our support team.</li>
                </ol>
              </section>

              <section>
                <h2 className="font-display text-2xl font-bold mb-4 text-foreground">9. Right to Refuse Returns</h2>
                <p>
                  FRONTIVA reserves the right to refuse returns that do not meet our return eligibility criteria, arrive outside the designated return window, or appear to have been worn, altered, or damaged by the customer. Items sent back to us without first requesting a return will not be accepted.
                </p>
              </section>

              <section>
                <h2 className="font-display text-2xl font-bold mb-4 text-foreground">10. Policy Updates</h2>
                <p>
                  We may update this Refund & Cancellation Policy from time to time to reflect changes in our practices or for other operational, legal, or regulatory reasons. The updated version will be indicated by a revised "Last updated" date at the top of this page.
                </p>
              </section>

              <section>
                <h2 className="font-display text-2xl font-bold mb-4 text-foreground">11. Contact Us</h2>
                <p className="mb-4">
                  If you have any questions or require assistance regarding our Refund & Cancellation Policy, please reach out to us:
                </p>
                <div className="bg-muted p-8 rounded-2xl border border-border/50 mt-6 space-y-4">
                  <p className="font-semibold text-xl text-foreground">FRONTIVA TRADING PRIVATE LIMITED</p>
                  <div className="flex flex-col sm:flex-row sm:gap-2">
                    <span className="font-medium text-foreground min-w-[80px] shrink-0 mt-0.5">Address:</span> 
                    <address className="not-italic text-muted-foreground leading-relaxed">
                      SHOP NO-3 DDA MARKET CSC,<br />
                      JAGITRI ENCLAVE SHAHDARA,<br />
                      New Delhi, Delhi, India, 110092
                    </address>
                  </div>
                  <p className="flex flex-col sm:flex-row sm:gap-2">
                    <span className="font-medium text-foreground min-w-[80px]">Email:</span> 
                    <a href="mailto:frontivatrading@gmail.com" className="text-primary hover:underline">frontivatrading@gmail.com</a>
                  </p>
                  <p className="flex flex-col sm:flex-row sm:gap-2">
                    <span className="font-medium text-foreground min-w-[80px]">Phone:</span> 
                    <a href="tel:7840873009" className="text-muted-foreground hover:text-primary transition-colors">7840873009</a>
                  </p>
                </div>
              </section>
            </div>
          </div>
        </main>

        <Footer />
      </div>
    </>
  );
};

export default RefundPolicyPage;