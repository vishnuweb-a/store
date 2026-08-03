import React from 'react';
import { motion } from 'framer-motion';
import { Link, useNavigate } from 'react-router-dom';
import { ShoppingCart, Star } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useCart } from '@/hooks/useCart';
import { useToast } from '@/hooks/use-toast';
 
const ProductCard = ({ product, index }) => {
  const { addToCart } = useCart();
  const { toast } = useToast();
  const navigate = useNavigate();

  const displayVariant = product.variants[0];
  const hasSale = displayVariant && displayVariant.sale_price_in_cents !== null;
  const displayPrice = hasSale ? displayVariant.sale_price_formatted : displayVariant.price_formatted;
  const originalPrice = hasSale ? displayVariant.price_formatted : null;
 
  const handleAddToCart = async (e) => {
    e.preventDefault();
    e.stopPropagation();

    // Sized products need a size picked first, so send the shopper to the product page.
    if (product.sizes?.length > 0) {
      navigate(`/product/${product.id}`);
      return;
    }

    try {
      await addToCart(product, displayVariant, 1, displayVariant.inventory_quantity);
      toast({
        title: "Added to cart",
        description: `${product.title} has been added to your cart.`,
      });
    } catch (error) {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    }
  };
 
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay: index * 0.05 }}
      className="group"
    >
      <Link to={`/product/${product.id}`}>
        <div className="bg-card rounded-xl overflow-hidden shadow-sm hover:shadow-lg transition-all duration-300">
          <div className="relative overflow-hidden aspect-[3/4]">
            <img
              src={product.image}
              alt={product.title}
              loading="lazy"
              className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
            />
            {product.ribbon_text && (
              <div className="absolute top-3 left-3 bg-secondary text-gray-800 text-xs font-semibold px-3 py-1 rounded-full">
                {product.ribbon_text}
              </div>
            )}
            <div className="absolute top-3 right-3 flex items-center gap-1 bg-white/90 backdrop-blur-sm px-2 py-1 rounded-full">
              <Star className="h-3 w-3 fill-secondary text-secondary" />
              <span className="text-xs text-gray-800 font-semibold">4.8</span>
            </div>
          </div>
          <div className="p-4">
            <h3 className="font-semibold text-base mb-1 truncate text-gray-800">{product.title}</h3>
            <p className="text-sm text-gray-800 mb-3 line-clamp-2">{product.subtitle || 'Premium quality fashion'}</p>
            <div className="flex items-center justify-between">
              <div className="flex items-baseline gap-2">
                <span className="text-lg text-gray-800 font-bold">{displayPrice}</span>
                {hasSale && (
                  <span className="text-sm text-gray-800 line-through">{originalPrice}</span>
                )}
              </div>
              <Button
                onClick={handleAddToCart}
                size="sm"
                className="bg-primary text-primary-foreground hover:bg-primary/90"
              >
                <ShoppingCart className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>
      </Link>
    </motion.div>
  );
};
 
export default ProductCard;