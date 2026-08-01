import React, { useState } from 'react';
import { Helmet } from 'react-helmet';
import { motion } from 'framer-motion';
import { Mail, Phone, MapPin } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import Header from '@/components/Header';
import Footer from '@/components/Footer';
import ShoppingCart from '@/components/ShoppingCart';

const ContactPage = () => {
  const [isCartOpen, setIsCartOpen] = useState(false);
  const [formData, setFormData] = useState({ name: '', email: '', message: '' });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const { toast } = useToast();

  // PENDING BACKEND INTEGRATION: this project has no server, serverless function
  // or email service, so there is no endpoint to submit this form to. Until one
  // exists, point customers at the email/phone shown on this page instead of
  // reporting a delivery that never happens. The typed message is intentionally
  // NOT cleared, so it can be copied into an email.
  const handleSubmit = (e) => {
    e.preventDefault();

    toast({
      title: 'Message not sent',
      description: 'Our contact form is not available yet. Please email frontivatrading@gmail.com or call 7840873009 and we will get back to you right away.',
      variant: 'destructive',
    });
  };

  const handleChange = (e) => {
    setFormData({ ...formData, [e.target.name]: e.target.value });
  };

  return (
    <>
      <Helmet>
        <title>Contact Us - FRONTIVA</title>
        <meta name="description" content="Get in touch with FRONTIVA TRADING PRIVATE LIMITED. We're here to help with any questions about our products." />
      </Helmet>

      <div className="min-h-screen flex flex-col">
        <Header setIsCartOpen={setIsCartOpen} />
        <ShoppingCart isCartOpen={isCartOpen} setIsCartOpen={setIsCartOpen} />

        <main className="flex-grow py-12 md:py-20">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6 }}
              className="text-center mb-12"
            >
              <h1 className="font-display text-4xl md:text-5xl font-bold mb-4 text-foreground">Get in Touch</h1>
              <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
                Have a question or feedback? We'd love to hear from you.
              </p>
            </motion.div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-12">
              <motion.div
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.6, delay: 0.2 }}
              >
                <div className="bg-card p-8 rounded-2xl shadow-lg border border-border/50">
                  <h2 className="font-display text-2xl font-bold mb-6 text-card-foreground">Send us a Message</h2>
                  <form onSubmit={handleSubmit} className="space-y-6">
                    <div>
                      <label htmlFor="name" className="block text-sm font-medium mb-2 text-card-foreground">
                        Name
                      </label>
                      <Input
                        id="name"
                        name="name"
                        type="text"
                        required
                        value={formData.name}
                        onChange={handleChange}
                        className="w-full text-foreground"
                        placeholder="Your name"
                      />
                    </div>
                    <div>
                      <label htmlFor="email" className="block text-sm font-medium mb-2 text-card-foreground">
                        Email
                      </label>
                      <Input
                        id="email"
                        name="email"
                        type="email"
                        required
                        value={formData.email}
                        onChange={handleChange}
                        className="w-full text-foreground"
                        placeholder="your.email@example.com"
                      />
                    </div>
                    <div>
                      <label htmlFor="message" className="block text-sm font-medium mb-2 text-card-foreground">
                        Message
                      </label>
                      <Textarea
                        id="message"
                        name="message"
                        required
                        value={formData.message}
                        onChange={handleChange}
                        rows={6}
                        className="w-full text-foreground"
                        placeholder="How can we help you?"
                      />
                    </div>
                    <Button
                      type="submit"
                      disabled={isSubmitting}
                      className="w-full bg-primary text-primary-foreground hover:bg-primary/90 font-semibold"
                    >
                      {isSubmitting ? 'Sending...' : 'Send Message'}
                    </Button>
                  </form>
                </div>
              </motion.div>

              <motion.div
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.6, delay: 0.4 }}
                className="space-y-8"
              >
                <div>
                  <h2 className="font-display text-2xl font-bold mb-8 text-foreground">Contact Information</h2>
                  <div className="space-y-8">
                    <div className="flex items-start gap-4">
                      <div className="bg-secondary/10 p-4 rounded-xl shrink-0">
                        <MapPin className="h-6 w-6 text-secondary" />
                      </div>
                      <div className="flex-1">
                        <h3 className="font-semibold mb-3 text-foreground text-lg">Address</h3>
                        <address className="not-italic">
                          <p className="font-semibold text-foreground mb-3">FRONTIVA TRADING PRIVATE LIMITED</p>
                          <p className="text-muted-foreground leading-relaxed text-base space-y-1">
                            <span className="block">SHOP NO-3 DDA MARKET CSC,</span>
                            <span className="block">JAGITRI ENCLAVE SHAHDARA,</span>
                            <span className="block">New Delhi, Delhi, India, 110092</span>
                          </p>
                        </address>
                      </div>
                    </div>
                    <div className="flex items-start gap-4">
                      <div className="bg-secondary/10 p-4 rounded-xl shrink-0">
                        <Mail className="h-6 w-6 text-secondary" />
                      </div>
                      <div>
                        <h3 className="font-semibold mb-2 text-foreground text-lg">Email</h3>
                        <a href="mailto:frontivatrading@gmail.com" className="text-muted-foreground hover:text-foreground transition-colors text-lg">
                          frontivatrading@gmail.com
                        </a>
                      </div>
                    </div>
                    <div className="flex items-start gap-4">
                      <div className="bg-secondary/10 p-4 rounded-xl shrink-0">
                        <Phone className="h-6 w-6 text-secondary" />
                      </div>
                      <div>
                        <h3 className="font-semibold mb-2 text-foreground text-lg">Phone</h3>
                        <a href="tel:7840873009" className="text-muted-foreground hover:text-foreground transition-colors text-lg">
                          7840873009
                        </a>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="bg-muted p-8 rounded-2xl border border-border/50">
                  <h3 className="font-semibold text-lg mb-4 text-foreground">Business Hours</h3>
                  <div className="space-y-3 text-muted-foreground">
                    <div className="flex justify-between items-center">
                      <span>Monday - Friday</span>
                      <span className="font-medium text-foreground">9:00 AM - 6:00 PM</span>
                    </div>
                    <div className="flex justify-between items-center border-t border-border pt-3">
                      <span>Saturday</span>
                      <span className="font-medium text-foreground">10:00 AM - 4:00 PM</span>
                    </div>
                    <div className="flex justify-between items-center border-t border-border pt-3">
                      <span>Sunday</span>
                      <span className="font-medium text-foreground">Closed</span>
                    </div>
                  </div>
                </div>
              </motion.div>
            </div>
          </div>
        </main>

        <Footer />
      </div>
    </>
  );
};

export default ContactPage;