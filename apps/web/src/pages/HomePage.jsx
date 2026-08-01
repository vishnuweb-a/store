import React, { useState, useEffect } from 'react';
import { Helmet } from 'react-helmet';
import { motion } from 'framer-motion';
import { Link } from 'react-router-dom';
import { ArrowRight, Star, Quote } from 'lucide-react';
import { Button } from '@/components/ui/button';
import CategoryCard from '@/components/CategoryCard';
import ProductCard from '@/components/ProductCard';
import Header from '@/components/Header';
import Footer from '@/components/Footer';
import ShoppingCart from '@/components/ShoppingCart';
import { getProducts } from '@/api/EcommerceApi';

const HomePage = () => {
  const [isCartOpen, setIsCartOpen] = useState(false);
  const [featuredProducts, setFeaturedProducts] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchFeaturedProducts = async () => {
      try {
        const response = await getProducts({ limit: '6' });
        setFeaturedProducts(response.products);
      } catch (error) {
        console.error('Error fetching products:', error);
      } finally {
        setLoading(false);
      }
    };

    fetchFeaturedProducts();
  }, []);

  const categories = [
    {
      name: "Men's Wear",
      slug: 'mens',
      image: 'https://images.unsplash.com/photo-1701759164397-d49e71987ab5',
      count: 47,
    },
    {
      name: "Women's Wear",
      slug: 'womens',
      image: 'https://images.unsplash.com/photo-1694201211076-8f9ef6f6386e',
      count: 63,
    },
  ];

  const testimonials = [
    {
      name: 'Priya Sharma',
      rating: 5,
      text: 'Outstanding quality and fit. The attention to detail in every piece is remarkable.',
    },
    {
      name: 'Arjun Mehta',
      rating: 5,
      text: 'Fast delivery and excellent customer service. My go-to store for premium clothing.',
    },
    {
      name: 'Kavya Reddy',
      rating: 5,
      text: 'Beautiful designs that blend traditional elegance with modern style perfectly.',
    },
  ];

  return (
    <>
      <Helmet>
        <title>FRONTIVA - Premium Fashion & Clothing</title>
        <meta name="description" content="Discover premium quality clothing with style and elegance at FRONTIVA. Shop men's and women's fashion collections." />
      </Helmet>

      <div className="min-h-screen flex flex-col">
        <Header setIsCartOpen={setIsCartOpen} />
        <ShoppingCart isCartOpen={isCartOpen} setIsCartOpen={setIsCartOpen} />

        <main className="flex-grow">
          <section className="relative min-h-[90vh] flex items-center justify-center overflow-hidden">
            <div className="absolute inset-0">
              <img
                src="https://images.unsplash.com/photo-1583530738247-444ce8342b9a"
                alt="Fashion hero"
                className="w-full h-full object-cover"
              />
              <div className="absolute inset-0 bg-gradient-to-r from-black/70 via-black/50 to-transparent" />
            </div>
            <div className="relative z-10 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 text-white">
              <motion.div
                initial={{ opacity: 0, y: 30 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.8 }}
                className="max-w-2xl"
              >
                <h1 className="font-display text-5xl md:text-6xl lg:text-7xl font-bold mb-6 leading-tight">
                  Premium Fashion for the Modern You
                </h1>
                <p className="text-xl md:text-2xl mb-8 text-white/90 leading-relaxed">
                  Discover timeless elegance and contemporary style with FRONTIVA's curated collections.
                </p>
                <div className="flex flex-wrap gap-4">
                  <Link to="/shop">
                    <Button size="lg" className="bg-secondary text-secondary-foreground hover:bg-secondary/90 font-semibold text-black">
                      Shop Now
                      <ArrowRight className="ml-2 h-5 w-5" />
                    </Button>
                  </Link>
                  <Link to="/about">
                    <Button size="lg" variant="outline" className="border-white hover:bg-white hover:text-primary font-semibold text-black">
                      Our Story
                    </Button>
                  </Link>
                </div>
              </motion.div>
            </div>
          </section>

          <section className="py-20 bg-background">
            <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.6 }}
                className="text-center mb-12"
              >
                <h2 className="font-display text-4xl md:text-5xl font-bold mb-4 text-foreground">Explore Collections</h2>
                <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
                  Curated selections for every style and occasion
                </p>
              </motion.div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                {categories.map((category, index) => (
                  <CategoryCard key={category.slug} category={category} index={index} />
                ))}
              </div>
            </div>
          </section>

          <section className="py-20 bg-muted">
            <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.6 }}
                className="text-center mb-12"
              >
                <h2 className="font-display text-4xl md:text-5xl font-bold mb-4 text-foreground">Featured Products</h2>
                <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
                  Handpicked favorites from our latest collection
                </p>
              </motion.div>
              {loading ? (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
                  {[...Array(6)].map((_, i) => (
                    <div key={i} className="bg-card rounded-xl h-96 animate-pulse" />
                  ))}
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
                  {featuredProducts.map((product, index) => (
                    <ProductCard key={product.id} product={product} index={index} />
                  ))}
                </div>
              )}
              <div className="text-center mt-12">
                <Link to="/shop">
                  <Button size="lg" className="bg-primary text-primary-foreground hover:bg-primary/90 font-semibold">
                    View All Products
                    <ArrowRight className="ml-2 h-5 w-5" />
                  </Button>
                </Link>
              </div>
            </div>
          </section>

          <section className="py-20 bg-background">
            <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.6 }}
                className="text-center mb-12"
              >
                <h2 className="font-display text-4xl md:text-5xl font-bold mb-4 text-foreground">What Our Customers Say</h2>
                <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
                  Real experiences from our valued customers
                </p>
              </motion.div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
                {testimonials.map((testimonial, index) => (
                  <motion.div
                    key={index}
                    initial={{ opacity: 0, y: 20 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true }}
                    transition={{ duration: 0.5, delay: index * 0.1 }}
                    className="bg-card p-6 rounded-xl shadow-sm"
                  >
                    <Quote className="h-8 w-8 text-secondary mb-4" />
                    <div className="flex gap-1 mb-4">
                      {[...Array(testimonial.rating)].map((_, i) => (
                        <Star key={i} className="h-4 w-4 fill-secondary text-secondary" />
                      ))}
                    </div>
                    <p className="text-card-foreground mb-4 leading-relaxed">{testimonial.text}</p>
                    <p className="font-semibold text-card-foreground">{testimonial.name}</p>
                  </motion.div>
                ))}
              </div>
            </div>
          </section>

          <section className="py-20 bg-primary text-primary-foreground">
            <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.6 }}
              >
                <h2 className="font-display text-4xl md:text-5xl font-bold mb-6">Ready to Upgrade Your Wardrobe?</h2>
                <p className="text-xl mb-8 text-primary-foreground/90 leading-relaxed">
                  Join thousands of satisfied customers who trust FRONTIVA for premium fashion.
                </p>
                <Link to="/shop">
                  <Button size="lg" className="bg-secondary text-secondary-foreground hover:bg-secondary/90 font-semibold text-black">
                    Explore Collection
                    <ArrowRight className="ml-2 h-5 w-5" />
                  </Button>
                </Link>
              </motion.div>
            </div>
          </section>
        </main>

        <Footer />
      </div>
    </>
  );
};

export default HomePage;