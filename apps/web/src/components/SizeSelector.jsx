import React from 'react';
import { motion } from 'framer-motion';

/**
 * Premium size picker rendered on the product page. Sizes come from the
 * products.sizes JSON column; entries with no stock render disabled.
 *
 * @param {{sizes: Array<{size: string, stock: number}>, selectedSize: string|null, onSelect: (size: string) => void}} props
 */
const SizeSelector = ({ sizes, selectedSize, onSelect }) => {
  if (!sizes || sizes.length === 0) {
    return null;
  }

  return (
    <div className="mb-6">
      <h3 className="text-sm font-medium text-gray-900 mb-2">Choose Size</h3>
      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Choose size">
        {sizes.map(({ size, stock }) => {
          const isSelected = selectedSize === size;
          const isDisabled = stock <= 0;

          return (
            <motion.button
              key={size}
              type="button"
              role="radio"
              aria-checked={isSelected}
              aria-label={isDisabled ? `Size ${size}, out of stock` : `Size ${size}`}
              disabled={isDisabled}
              onClick={() => onSelect(size)}
              whileHover={isDisabled ? undefined : { scale: 1.05 }}
              whileTap={isDisabled ? undefined : { scale: 0.95 }}
              className={`min-w-[3rem] h-12 px-4 rounded-full border-2 text-sm font-semibold transition-all ${
                isDisabled
                  ? 'border-border text-muted-foreground opacity-40 cursor-not-allowed line-through'
                  : isSelected
                    ? 'border-primary bg-primary text-primary-foreground shadow-md'
                    : 'border-border text-gray-900 hover:border-primary hover:bg-muted'
              }`}
            >
              {size}
            </motion.button>
          );
        })}
      </div>
      {selectedSize && (
        <p className="mt-2 text-sm text-muted-foreground">
          Selected size: <span className="font-semibold text-gray-900">{selectedSize}</span>
        </p>
      )}
    </div>
  );
};

export default SizeSelector;
