import React, { useState } from 'react';
import { Helmet } from 'react-helmet';
import { Link } from 'react-router-dom';
import { Home, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import Header from '@/components/Header';
import Footer from '@/components/Footer';
import ShoppingCart from '@/components/ShoppingCart';

const NotFoundPage = () => {
  const [isCartOpen, setIsCartOpen] = useState(false);

  return (
    <>
      <Helmet>
        <title>Page Not Found - FRONTIVA</title>
        <meta name="description" content="The page you are looking for could not be found." />
      </Helmet>

      <div className="min-h-screen flex flex-col">
        <Header setIsCartOpen={setIsCartOpen} />
        <ShoppingCart isCartOpen={isCartOpen} setIsCartOpen={setIsCartOpen} />

        <main className="flex-grow flex items-center justify-center py-12">
          <div className="max-w-2xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
            <div className="mb-8">
              <h1 className="font-display text-9xl font-bold text-primary mb-4">404</h1>
              <h2 className="font-display text-3xl md:text-4xl font-bold mb-4 text-foreground">Page Not Found</h2>
              <p className="text-lg text-muted-foreground mb-8">
                The page you are looking for might have been removed, had its name changed, or is temporarily unavailable.
              </p>
            </div>

            <div className="flex flex-col sm:flex-row gap-4 justify-center">
              <Link to="/">
                <Button size="lg" className="bg-primary text-primary-foreground hover:bg-primary/90 font-semibold w-full sm:w-auto">
                  <Home className="mr-2 h-5 w-5" />
                  Back to Home
                </Button>
              </Link>
              <Link to="/shop">
                <Button size="lg" variant="outline" className="w-full sm:w-auto">
                  <Search className="mr-2 h-5 w-5" />
                  Browse Products
                </Button>
              </Link>
            </div>
          </div>
        </main>

        <Footer />
      </div>
    </>
  );
};

export default NotFoundPage;