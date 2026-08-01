import React, { useState } from 'react';
import { Helmet } from 'react-helmet';
import Header from '@/components/Header.jsx';
import Footer from '@/components/Footer.jsx';
import ShoppingCart from '@/components/ShoppingCart.jsx';

const TermsAndConditionsPage = () => {
  const [isCartOpen, setIsCartOpen] = useState(false);

  return (
    <>
      <Helmet>
        <title>Terms and Conditions - FRONTIVA</title>
        <meta name="description" content="Terms and Conditions for FRONTIVA TRADING PRIVATE LIMITED. Read our policies on website use, ordering, and liability." />
      </Helmet>

      <div className="min-h-screen flex flex-col bg-background">
        <Header setIsCartOpen={setIsCartOpen} />
        <ShoppingCart isCartOpen={isCartOpen} setIsCartOpen={setIsCartOpen} />

        <main className="flex-grow py-16 md:py-24">
          <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="mb-12">
              <h1 className="font-display text-4xl md:text-5xl font-bold mb-4 text-foreground text-balance">
                Terms and Conditions
              </h1>
              <p className="text-muted-foreground">Last updated: June 27, 2026</p>
            </div>

            <div className="space-y-12 text-foreground/90 leading-relaxed">
              <section>
                <h2 className="font-display text-2xl font-bold mb-4 text-foreground">1. Introduction and Acceptance of Terms</h2>
                <p className="mb-4">
                  Welcome to FRONTIVA TRADING PRIVATE LIMITED. These Terms and Conditions govern your access to and use of our website and services. By accessing, browsing, or making a purchase on our website, you acknowledge that you have read, understood, and agree to be bound by these terms. If you do not agree with any part of these terms, please refrain from using our services.
                </p>
              </section>

              <section>
                <h2 className="font-display text-2xl font-bold mb-4 text-foreground">2. Use of Website and Services</h2>
                <p className="mb-4">
                  You agree to use our website only for lawful purposes. You are strictly prohibited from using the site to post or transmit any material that is infringing, threatening, false, misleading, abusive, harassing, libelous, defamatory, vulgar, obscene, scandalous, inflammatory, pornographic, or profane. We reserve the right to terminate your use of our services for violating any of these prohibited uses.
                </p>
              </section>

              <section>
                <h2 className="font-display text-2xl font-bold mb-4 text-foreground">3. Product Information and Pricing</h2>
                <p className="mb-4">
                  While we strive for accuracy in product descriptions, imagery, and pricing, errors may occasionally occur. We reserve the right to correct any errors, inaccuracies, or omissions, and to change or update information at any time without prior notice (including after an order has been submitted). All prices are subject to change without notice.
                </p>
              </section>

              <section>
                <h2 className="font-display text-2xl font-bold mb-4 text-foreground">4. Ordering and Payment Terms</h2>
                <p className="mb-4">
                  By placing an order, you represent that you are legally capable of entering into binding contracts. After placing an order, you will receive an email acknowledging that we have received your request. This does not mean your order has been accepted. Your order constitutes an offer to purchase a product. All orders are subject to acceptance by us. Payments are processed securely at the time of checkout.
                </p>
              </section>

              <section>
                <h2 className="font-display text-2xl font-bold mb-4 text-foreground">5. Shipping and Delivery</h2>
                <p className="mb-4">
                  We endeavor to dispatch orders swiftly. Delivery timeframes provided are estimates and are not guaranteed. Risk of loss and title for items purchased pass to you upon delivery of the items to the carrier. We are not responsible for delays caused by external factors outside our direct control, such as customs processing or carrier delays.
                </p>
              </section>

              <section>
                <h2 className="font-display text-2xl font-bold mb-4 text-foreground">6. Returns and Refunds Policy</h2>
                <p className="mb-4">
                  Customer satisfaction is our priority. If you are not completely satisfied with your purchase, you may be eligible to return the item within our specified return window (typically 14-30 days, depending on the product category). Returned items must be unworn, unwashed, and retain all original tags. Refunds will be issued to the original payment method after the returned item has been inspected and approved.
                </p>
              </section>

              <section>
                <h2 className="font-display text-2xl font-bold mb-4 text-foreground">7. Intellectual Property Rights</h2>
                <p className="mb-4">
                  All content included on this site, such as text, graphics, logos, images, audio clips, video, data compilations, and software, is the property of FRONTIVA TRADING PRIVATE LIMITED or its content suppliers and is protected by international copyright and intellectual property laws. You may not extract or utilize parts of our content without our express written consent.
                </p>
              </section>

              <section>
                <h2 className="font-display text-2xl font-bold mb-4 text-foreground">8. Limitation of Liability</h2>
                <p className="mb-4">
                  To the fullest extent permitted by applicable law, FRONTIVA TRADING PRIVATE LIMITED shall not be liable for any indirect, incidental, special, consequential, or punitive damages, or any loss of profits or revenues, whether incurred directly or indirectly, or any loss of data, use, goodwill, or other intangible losses resulting from your access to or use of, or inability to access or use, our services.
                </p>
              </section>

              <section>
                <h2 className="font-display text-2xl font-bold mb-4 text-foreground">9. Dispute Resolution</h2>
                <p className="mb-4">
                  Any dispute relating in any way to your visit to our website or to products you purchase from us shall be submitted to confidential arbitration in the jurisdiction where FRONTIVA TRADING PRIVATE LIMITED is registered, except that, to the extent you have in any manner violated or threatened to violate our intellectual property rights, we may seek injunctive or other appropriate relief in any state or federal court.
                </p>
              </section>

              <section>
                <h2 className="font-display text-2xl font-bold mb-4 text-foreground">10. Contact Information</h2>
                <p className="mb-4">
                  For questions regarding these Terms and Conditions, please contact our legal and support team:
                </p>
                <div className="bg-muted p-8 rounded-2xl border border-border/50 mt-6 space-y-4">
                  <p className="font-semibold text-xl text-foreground">FRONTIVA TRADING PRIVATE LIMITED</p>
                  <p className="flex flex-col sm:flex-row sm:gap-2">
                    <span className="font-medium text-foreground min-w-[80px]">Address:</span> 
                    <span className="text-muted-foreground">SHOP NO-3 DDA MARKET CSC, JAGITRI ENCLAVE SHAHDARA, New Delhi, Delhi, India, 110092</span>
                  </p>
                  <p className="flex flex-col sm:flex-row sm:gap-2">
                    <span className="font-medium text-foreground min-w-[80px]">Email:</span> 
                    <a href="mailto:frontivatrading@gmail.com" className="text-primary hover:underline">frontivatrading@gmail.com</a>
                  </p>
                  <p className="flex flex-col sm:flex-row sm:gap-2">
                    <span className="font-medium text-foreground min-w-[80px]">Phone:</span> 
                    <span className="text-muted-foreground">7840873009</span>
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

export default TermsAndConditionsPage;