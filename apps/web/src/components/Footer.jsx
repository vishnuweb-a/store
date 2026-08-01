import React from 'react';
import { Link } from 'react-router-dom';
import { Mail, Phone, Facebook, Instagram, Twitter, MapPin } from 'lucide-react';

const Footer = () => {
  const currentYear = new Date().getFullYear();

  return (
    <footer className="bg-primary text-primary-foreground mt-20">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-8 mb-8">
          <div className="lg:col-span-1">
            <h3 className="font-display text-2xl font-bold mb-4">FRONTIVA</h3>
            <p className="text-sm text-primary-foreground/80 leading-relaxed">
              FRONTIVA TRADING PRIVATE LIMITED delivers premium quality clothing with style and elegance.
            </p>
          </div>

          <div>
            <h4 className="font-semibold text-lg mb-4">Quick Links</h4>
            <nav className="space-y-2">
              <Link to="/" className="block text-sm text-primary-foreground/80 hover:text-primary-foreground transition-colors">
                Home
              </Link>
              <Link to="/shop" className="block text-sm text-primary-foreground/80 hover:text-primary-foreground transition-colors">
                Shop
              </Link>
              <Link to="/about" className="block text-sm text-primary-foreground/80 hover:text-primary-foreground transition-colors">
                About
              </Link>
              <Link to="/contact" className="block text-sm text-primary-foreground/80 hover:text-primary-foreground transition-colors">
                Contact
              </Link>
            </nav>
          </div>

          <div>
            <h4 className="font-semibold text-lg mb-4">Legal</h4>
            <nav className="space-y-2">
              <Link to="/privacy" className="block text-sm text-primary-foreground/80 hover:text-primary-foreground transition-colors">
                Privacy Policy
              </Link>
              <Link to="/terms" className="block text-sm text-primary-foreground/80 hover:text-primary-foreground transition-colors">
                Terms & Conditions
              </Link>
              <Link to="/refund-policy" className="block text-sm text-primary-foreground/80 hover:text-primary-foreground transition-colors">
                Refund & Cancellation Policy
              </Link>
            </nav>
          </div>

          <div>
            <h4 className="font-semibold text-lg mb-4">Contact Us</h4>
            <div className="space-y-4">
              <div className="flex items-start gap-3 text-sm text-primary-foreground/80">
                <MapPin className="h-4 w-4 mt-0.5 shrink-0" />
                <span className="leading-relaxed">
                  SHOP NO-3 DDA MARKET CSC,<br />
                  JAGITRI ENCLAVE SHAHDARA,<br />
                  New Delhi, Delhi, India, 110092
                </span>
              </div>
              <a href="mailto:frontivatrading@gmail.com" className="flex items-center gap-3 text-sm text-primary-foreground/80 hover:text-primary-foreground transition-colors">
                <Mail className="h-4 w-4 shrink-0" />
                frontivatrading@gmail.com
              </a>
              <a href="tel:7840873009" className="flex items-center gap-3 text-sm text-primary-foreground/80 hover:text-primary-foreground transition-colors">
                <Phone className="h-4 w-4 shrink-0" />
                7840873009
              </a>
              <div className="flex gap-4 mt-4 pt-2">
                <a href="#" className="text-primary-foreground/80 hover:text-primary-foreground transition-colors" aria-label="Facebook">
                  <Facebook className="h-5 w-5" />
                </a>
                <a href="#" className="text-primary-foreground/80 hover:text-primary-foreground transition-colors" aria-label="Instagram">
                  <Instagram className="h-5 w-5" />
                </a>
                <a href="#" className="text-primary-foreground/80 hover:text-primary-foreground transition-colors" aria-label="Twitter">
                  <Twitter className="h-5 w-5" />
                </a>
              </div>
            </div>
          </div>
        </div>

        <div className="border-t border-primary-foreground/20 pt-8 mt-8">
          <div className="flex justify-center md:justify-start items-center text-center md:text-left">
            <p className="text-sm text-primary-foreground/80">
              © {currentYear} FRONTIVA TRADING PRIVATE LIMITED. All rights reserved.
            </p>
          </div>
        </div>
      </div>
    </footer>
  );
};

export default Footer;