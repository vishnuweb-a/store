import React from 'react';
import { motion } from 'framer-motion';
import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';

const CategoryCard = ({ category, index }) => {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.6, delay: index * 0.1 }}
      className="group relative overflow-hidden rounded-xl"
    >
      <Link to={`/shop?category=${category.slug}`}>
        <div className="relative h-96 overflow-hidden">
          <img
            src={category.image}
            alt={category.name}
            className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
          />
          <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/30 to-transparent" />
          <div className="absolute bottom-0 left-0 right-0 p-8 text-white">
            <h3 className="font-display text-3xl font-bold mb-2">{category.name}</h3>
            <p className="text-sm text-white/90 mb-4">{category.count} products</p>
            <Button
              variant="outline"
              className="border-white hover:bg-white hover:text-primary transition-all duration-300 text-black font-semibold"
            >
              Browse Collection
              <ArrowRight className="ml-2 h-4 w-4" />
            </Button>
          </div>
        </div>
      </Link>
    </motion.div>
  );
};

export default CategoryCard;