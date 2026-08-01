import React, { useState } from 'react';
import { Helmet } from 'react-helmet';
import { motion } from 'framer-motion';
import { Award, Heart, Leaf, Users } from 'lucide-react';
import Header from '@/components/Header';
import Footer from '@/components/Footer';
import ShoppingCart from '@/components/ShoppingCart';

const AboutPage = () => {
  const [isCartOpen, setIsCartOpen] = useState(false);

  const values = [
    {
      icon: Award,
      title: 'Quality',
      description: 'We source only the finest materials and work with skilled artisans to ensure every piece meets our high standards.',
    },
    {
      icon: Heart,
      title: 'Style',
      description: 'Our designs blend timeless elegance with contemporary trends, creating pieces that stand the test of time.',
    },
    {
      icon: Leaf,
      title: 'Sustainability',
      description: 'We are committed to ethical practices and sustainable production methods that respect our planet.',
    },
    {
      icon: Users,
      title: 'Customer Focus',
      description: 'Your satisfaction is our priority. We provide exceptional service and support at every step.',
    },
  ];

  return (
    <>
      <Helmet>
        <title>About Us - FRONTIVA</title>
        <meta name="description" content="Learn about FRONTIVA TRADING PRIVATE LIMITED - delivering premium quality clothing with style and elegance." />
      </Helmet>

      <div className="min-h-screen flex flex-col">
        <Header setIsCartOpen={setIsCartOpen} />
        <ShoppingCart isCartOpen={isCartOpen} setIsCartOpen={setIsCartOpen} />

        <main className="flex-grow">
          <section className="py-20 bg-background">
            <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.6 }}
                className="text-center mb-12"
              >
                <h1 className="font-display text-5xl md:text-6xl font-bold mb-6 text-foreground">About FRONTIVA</h1>
                <p className="text-xl text-muted-foreground leading-relaxed">
                  Delivering premium quality clothing with style and elegance
                </p>
              </motion.div>
            </div>
          </section>

          <section className="py-16 bg-muted">
            <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.6 }}
              >
                <h2 className="font-display text-3xl md:text-4xl font-bold mb-6 text-foreground">Our Story</h2>
                <div className="space-y-4 text-lg text-foreground leading-relaxed">
                  <p>
                    FRONTIVA TRADING PRIVATE LIMITED was founded with a simple yet powerful vision: to make premium fashion accessible to those who appreciate quality and style. We believe that clothing is more than just fabric—it's an expression of who you are.
                  </p>
                  <p>
                    Our journey began with a commitment to sourcing the finest materials and partnering with skilled craftspeople who share our passion for excellence. Every piece in our collection is carefully curated to ensure it meets our exacting standards for quality, fit, and design.
                  </p>
                  <p>
                    Today, we serve customers across the country, offering a diverse range of men's and women's fashion that combines timeless elegance with contemporary style. Our dedication to customer satisfaction and sustainable practices has made us a trusted name in premium fashion.
                  </p>
                </div>
              </motion.div>
            </div>
          </section>

          <section className="py-16 bg-background">
            <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.6 }}
                className="text-center mb-12"
              >
                <h2 className="font-display text-3xl md:text-4xl font-bold mb-4 text-foreground">Our Core Values</h2>
                <p className="text-lg text-muted-foreground">The principles that guide everything we do</p>
              </motion.div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                {values.map((value, index) => (
                  <motion.div
                    key={index}
                    initial={{ opacity: 0, y: 20 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true }}
                    transition={{ duration: 0.5, delay: index * 0.1 }}
                    className="bg-card p-6 rounded-xl shadow-sm"
                  >
                    <value.icon className="h-12 w-12 text-secondary mb-4" />
                    <h3 className="font-semibold text-xl mb-3 text-card-foreground">{value.title}</h3>
                    <p className="text-card-foreground/80 leading-relaxed">{value.description}</p>
                  </motion.div>
                ))}
              </div>
            </div>
          </section>

          <section className="py-16 bg-primary text-primary-foreground">
            <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.6 }}
              >
                <h2 className="font-display text-3xl md:text-4xl font-bold mb-6">Our Mission</h2>
                <p className="text-xl leading-relaxed text-primary-foreground/90 max-w-3xl mx-auto">
                  To deliver premium quality clothing that empowers individuals to express their unique style with confidence, while maintaining our commitment to ethical practices and exceptional customer service.
                </p>
              </motion.div>
            </div>
          </section>
        </main>

        <Footer />
      </div>
    </>
  );
};

export default AboutPage;