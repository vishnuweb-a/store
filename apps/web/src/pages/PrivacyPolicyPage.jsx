import React, { useState } from 'react';
import { Helmet } from 'react-helmet';
import Header from '@/components/Header.jsx';
import Footer from '@/components/Footer.jsx';
import ShoppingCart from '@/components/ShoppingCart.jsx';

const PrivacyPolicyPage = () => {
  const [isCartOpen, setIsCartOpen] = useState(false);

  return (
    <>
      <Helmet>
        <title>Privacy Policy - FRONTIVA</title>
        <meta name="description" content="Privacy Policy for FRONTIVA TRADING PRIVATE LIMITED. Learn how we collect, use, and protect your data." />
      </Helmet>

      <div className="min-h-screen flex flex-col bg-background">
        <Header setIsCartOpen={setIsCartOpen} />
        <ShoppingCart isCartOpen={isCartOpen} setIsCartOpen={setIsCartOpen} />

        <main className="flex-grow py-16 md:py-24">
          <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="mb-12">
              <h1 className="font-display text-4xl md:text-5xl font-bold mb-4 text-foreground text-balance">
                Privacy Policy
              </h1>
              <p className="text-muted-foreground">Last updated: June 27, 2026</p>
            </div>

            <div className="space-y-12 text-foreground/90 leading-relaxed">
              <section>
                <h2 className="font-display text-2xl font-bold mb-4 text-foreground">1. Introduction</h2>
                <p className="mb-4">
                  Welcome to FRONTIVA TRADING PRIVATE LIMITED. We respect your privacy and are deeply committed to protecting your personal data. This Privacy Policy details our practices regarding the collection, use, and safeguarding of your information when you visit our website, interact with our services, or make a purchase from our premium collections.
                </p>
                <p>
                  By using our website, you agree to the collection and use of information in accordance with this policy.
                </p>
              </section>

              <section>
                <h2 className="font-display text-2xl font-bold mb-4 text-foreground">2. Information We Collect</h2>
                <p className="mb-4">We collect various types of information to provide and improve our service to you:</p>
                <ul className="list-disc pl-6 space-y-2 mb-4">
                  <li><strong>Personal Data:</strong> Identifiable information such as your name, email address, phone number, shipping address, and billing address.</li>
                  <li><strong>Browsing Data:</strong> Information automatically collected during your visit, including your IP address, browser type, device information, and pages visited.</li>
                  <li><strong>Payment Information:</strong> Credit card numbers and related payment details (processed securely via our certified third-party payment gateways; we do not store full credit card numbers on our servers).</li>
                </ul>
              </section>

              <section>
                <h2 className="font-display text-2xl font-bold mb-4 text-foreground">3. How We Use Your Information</h2>
                <p className="mb-4">The collected data is utilized for various purposes critical to our operations:</p>
                <ul className="list-disc pl-6 space-y-2 mb-4">
                  <li><strong>Order Processing:</strong> Fulfilling and delivering your purchases, communicating order statuses, and handling returns.</li>
                  <li><strong>Customer Service:</strong> Addressing your inquiries, complaints, and requests promptly.</li>
                  <li><strong>Marketing:</strong> Sending promotional emails and exclusive offers (you may opt out at any time).</li>
                  <li><strong>Analytics & Improvement:</strong> Understanding how our customers use our site to enhance user experience, refine our product offerings, and optimize our platform.</li>
                </ul>
              </section>

              <section>
                <h2 className="font-display text-2xl font-bold mb-4 text-foreground">4. Data Security and Protection Measures</h2>
                <p className="mb-4">
                  The security of your data is paramount. FRONTIVA employs industry-standard security protocols to prevent unauthorized access, alteration, disclosure, or destruction of your personal information. We utilize Secure Socket Layer (SSL) encryption for all transactions, secure server storage, and strict access controls for our personnel.
                </p>
              </section>

              <section>
                <h2 className="font-display text-2xl font-bold mb-4 text-foreground">5. Cookies and Tracking</h2>
                <p className="mb-4">
                  Our website uses "cookies" and similar tracking technologies to track activity on our service and hold certain information. Cookies are files with a small amount of data which may include an anonymous unique identifier.
                </p>
                <p>
                  You can instruct your browser to refuse all cookies or to indicate when a cookie is being sent. However, if you do not accept cookies, you may not be able to use some portions of our service (e.g., maintaining items in your shopping cart).
                </p>
              </section>

              <section>
                <h2 className="font-display text-2xl font-bold mb-4 text-foreground">6. Third-Party Sharing</h2>
                <p className="mb-4">
                  FRONTIVA does not sell your personal information. We may share necessary data with trusted third parties strictly for the purpose of operating our business, such as:
                </p>
                <ul className="list-disc pl-6 space-y-2 mb-4">
                  <li>Payment processors to securely handle your transactions.</li>
                  <li>Logistics and shipping partners to deliver your orders.</li>
                  <li>Marketing platforms and analytics providers, under strict confidentiality agreements.</li>
                </ul>
              </section>

              <section>
                <h2 className="font-display text-2xl font-bold mb-4 text-foreground">7. User Rights and Data Access</h2>
                <p className="mb-4">
                  Depending on your jurisdiction, you have the right to access, modify, update, or request deletion of your personal data. If you wish to exercise these rights, please reach out to us using the contact information provided below. We will address your request promptly and in accordance with applicable data protection laws.
                </p>
              </section>

              <section>
                <h2 className="font-display text-2xl font-bold mb-4 text-foreground">8. Contact Information</h2>
                <p className="mb-4">
                  If you have any questions, concerns, or requests regarding this Privacy Policy or our data practices, please contact us:
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

export default PrivacyPolicyPage;