import React, { useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import { Button, CircularProgress } from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import { useNavigate, useLocation } from 'react-router-dom';
import './SearchBar.css';

interface SearchBarProps {
  onSearchResults: (results: unknown[]) => void;
}

const SearchBar: React.FC<SearchBarProps> = ({ onSearchResults }) => {
  const [query, setQuery] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();

  const fetchAllPostsWithoutNavigation = useCallback(async (): Promise<void> => {
    try {
      setIsSearching(true);
      const response = await axios.get<unknown[]>('/api/posts', {
        headers: { Authorization: `Bearer ${localStorage.getItem('token')}` },
      });
      if (typeof onSearchResults === 'function') {
        onSearchResults(response.data);
      }
    } catch (err) {
      console.error('Failed to fetch posts:', err);
      if (typeof onSearchResults === 'function') {
        onSearchResults([]);
      }
    } finally {
      setIsSearching(false);
    }
  }, [onSearchResults]);

  const performLocalSearch = useCallback(
    async (searchQuery: string): Promise<void> => {
      if (!searchQuery.trim()) {
        fetchAllPostsWithoutNavigation();
        return;
      }

      try {
        setIsSearching(true);
        const response = await axios.get<unknown[]>('/api/posts/search', {
          params: { query: searchQuery },
        });
        if (typeof onSearchResults === 'function') {
          onSearchResults(response.data);
        }
      } catch (err) {
        console.error('Search failed:', err);
        fetchAllPostsWithoutNavigation();
      } finally {
        setIsSearching(false);
      }
    },
    [fetchAllPostsWithoutNavigation, onSearchResults],
  );

  useEffect(() => {
    const searchParams = new URLSearchParams(location.search);
    const queryParam = searchParams.get('q');
    if (queryParam) {
      setQuery(queryParam);
      if (location.pathname === '/feed') {
        performLocalSearch(queryParam);
      }
    }
  }, [location.pathname, location.search, performLocalSearch]);

  const performSearchWithNavigation = async (searchQuery: string): Promise<void> => {
    try {
      setIsSearching(true);
      const params = new URLSearchParams();
      if (searchQuery.trim()) {
        params.set('q', searchQuery.trim());
      }

      if (location.pathname !== '/feed') {
        navigate({ pathname: '/feed', search: params.toString() });
      } else if (searchQuery.trim()) {
        navigate({ pathname: '/feed', search: params.toString() }, { replace: true });
        const response = await axios.get<unknown[]>('/api/posts/search', {
          params: { query: searchQuery },
        });
        if (typeof onSearchResults === 'function') {
          onSearchResults(response.data);
        }
      } else {
        fetchAllPostsWithoutNavigation();
      }
    } catch (err) {
      console.error('Search failed:', err);
      fetchAllPostsWithoutNavigation();
    } finally {
      setIsSearching(false);
    }
  };

  const handleSearch = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const value = e.target.value;
    setQuery(value);
    if (value.trim() && location.pathname === '/feed') {
      performLocalSearch(value);
    }
  };

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>): void => {
    e.preventDefault();
    performSearchWithNavigation(query);
  };

  const isPodPage = location.pathname.includes('/pods');

  return (
    <div className={`search-bar ${isPodPage ? 'pod-search' : ''}`}>
      <form className="search-inputs" onSubmit={handleSubmit}>
        <input
          type="text"
          placeholder="Search posts by content or #tags..."
          value={query}
          onChange={handleSearch}
          className="search-input"
          aria-label="Search"
        />
        <Button
          variant="contained"
          color="primary"
          type="submit"
          className="search-button"
          disabled={isSearching}
          startIcon={isSearching ? <CircularProgress size={20} color="inherit" /> : <SearchIcon />}
          aria-label="Submit search"
        >
          {isSearching ? 'Searching...' : 'Search'}
        </Button>
      </form>
    </div>
  );
};

export default SearchBar;
