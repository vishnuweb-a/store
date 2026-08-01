import React, { useState, useEffect } from 'react';
import { Helmet } from 'react-helmet';
import { useSearchParams } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import Header from '@/components/Header';
import Footer from '@/components/Footer';
import ShoppingCart from '@/components/ShoppingCart';
import ProductCard from '@/components/ProductCard';
import { Button } from '@/components/ui/button';
import { getProducts, getCategories } from '@/api/EcommerceApi';

const ShopPage = () => {
  const [isCartOpen, setIsCartOpen] = useState(false);
  const [products, setProducts] = useState([]);
  const [apiCategories, setApiCategories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchParams, setSearchParams] = useSearchParams();
  const [selectedCategory, setSelectedCategory] = useState(searchParams.get('category') || 'all');

  useEffect(() => {
    const fetchProducts = async () => {
      try {
        setLoading(true);
        const response = await getProducts();
        setProducts(response.products);
      } catch (error) {
        console.error('Error fetching products:', error);
      } finally {
        setLoading(false);
      }
    };

    fetchProducts();
  }, []);

  useEffect(() => {
    const fetchCategories = async () => {
      try {
        const response = await getCategories();
        setApiCategories(response.categories);
      } catch (error) {
        console.error('Error fetching categories:', error);
      }
    };

    fetchCategories();
  }, []);

  const handleCategoryChange = (category) => {
    setSelectedCategory(category);
    if (category === 'all') {
      searchParams.delete('category');
    } else {
      searchParams.set('category', category);
    }
    setSearchParams(searchParams);
  };

  const categories = [
    { name: 'All Products', value: 'all' },
    ...apiCategories.map((category) => ({ name: category.title, value: category.id })),
  ];

  const isKnownCategory = apiCategories.some((category) => category.id === selectedCategory);

  const filteredProducts = selectedCategory === 'all' || !isKnownCategory
    ? products
    : products.filter((product) =>
        product.collections.some((collection) => collection.collection_id === selectedCategory)
      );

  return (
    <>
      <Helmet>
        <title>Shop - FRONTIVA</title>
        <meta name="description" content="Browse our complete collection of premium fashion clothing for men and women." />
      </Helmet>

      <div className="min-h-screen flex flex-col">
        <Header setIsCartOpen={setIsCartOpen} />
        <ShoppingCart isCartOpen={isCartOpen} setIsCartOpen={setIsCartOpen} />

        <main className="flex-grow py-12">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="mb-8">
              <h1 className="font-display text-4xl md:text-5xl font-bold mb-4 text-foreground">Shop Collection</h1>
              <p className="text-lg text-muted-foreground">Discover our premium fashion pieces</p>
            </div>

            <div className="flex flex-wrap gap-3 mb-8">
              {categories.map((category) => (
                <Button
                  key={category.value}
                  onClick={() => handleCategoryChange(category.value)}
                  variant={selectedCategory === category.value ? 'default' : 'outline'}
                  className={selectedCategory === category.value ? 'bg-primary text-primary-foreground' : ''}
                >
                  {category.name}
                </Button>
              ))}
            </div>

            {loading ? (
              <div className="flex justify-center items-center h-64">
                <Loader2 className="h-12 w-12 text-primary animate-spin" />
              </div>
            ) : filteredProducts.length === 0 ? (
              <div className="text-center py-12">
                <p className="text-muted-foreground text-lg">No products found.</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
                {filteredProducts.map((product, index) => (
                  <ProductCard key={product.id} product={product} index={index} />
                ))}
              </div>
            )}
          </div>
        </main>

        <Footer />
      </div>
    </>
  );
};

export default ShopPage;