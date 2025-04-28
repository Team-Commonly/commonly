import React, { useState, useEffect, useCallback } from 'react';
import PropTypes from 'prop-types';
import axios from 'axios';
import { Button, CircularProgress } from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import { useNavigate, useLocation } from 'react-router-dom';
import './SearchBar.css';

const SearchBar = ({ onSearchResults }) => {
    const [query, setQuery] = useState('');
    const [isSearching, setIsSearching] = useState(false);
    const navigate = useNavigate();
    const location = useLocation();

    // This function fetches all posts without navigation
    const fetchAllPostsWithoutNavigation = useCallback(async () => {
        try {
            setIsSearching(true);
            const response = await axios.get('/api/posts', {
                headers: { Authorization: `Bearer ${localStorage.getItem('token')}` }
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

    // This function performs the search without navigation
    const performLocalSearch = useCallback(async (searchQuery) => {
        if (!searchQuery.trim()) {
            fetchAllPostsWithoutNavigation();
            return;
        }

        try {
            setIsSearching(true);
            const response = await axios.get('/api/posts/search', { 
                params: { query: searchQuery }
            });
            
            if (typeof onSearchResults === 'function') {
                onSearchResults(response.data);
            } else {
                console.warn('onSearchResults is not a function');
            }
        } catch (err) {
            console.error('Search failed:', err);
            fetchAllPostsWithoutNavigation();
        } finally {
            setIsSearching(false);
        }
    }, [fetchAllPostsWithoutNavigation, onSearchResults]);

    // On mount, set query from URL if present
    useEffect(() => {
        const searchParams = new URLSearchParams(location.search);
        const queryParam = searchParams.get('q');
        if (queryParam) {
            setQuery(queryParam);
            
            // If on feed page, perform search
            if (location.pathname === '/feed') {
                performLocalSearch(queryParam);
            }
        }
    }, [location.pathname, location.search, performLocalSearch]);

    // This function performs search with navigation to feed
    const performSearchWithNavigation = async (searchQuery) => {
        try {
            setIsSearching(true);
            
            // Update URL with search query
            const params = new URLSearchParams();
            if (searchQuery.trim()) {
                params.set('q', searchQuery.trim());
            }
            
            // Navigate to feed page with search query
            if (location.pathname !== '/feed') {
                navigate({
                    pathname: '/feed',
                    search: params.toString()
                });
            } else if (searchQuery.trim()) {
                // Just update the URL without navigation if already on feed
                navigate({
                    pathname: '/feed',
                    search: params.toString()
                }, { replace: true });
                
                // Perform the search
                const response = await axios.get('/api/posts/search', { 
                    params: { query: searchQuery }
                });
                
                if (typeof onSearchResults === 'function') {
                    onSearchResults(response.data);
                }
            } else {
                // Empty search, fetch all posts
                fetchAllPostsWithoutNavigation();
            }
        } catch (err) {
            console.error('Search failed:', err);
            fetchAllPostsWithoutNavigation();
        } finally {
            setIsSearching(false);
        }
    };

    const handleSearch = (e) => {
        const value = e.target.value;
        setQuery(value);
        
        // Only perform local search when typing, no navigation
        if (value.trim() && location.pathname === '/feed') {
            performLocalSearch(value);
        }
    };

    const handleSubmit = (e) => {
        e.preventDefault();
        // Only navigate when submitting the form
        performSearchWithNavigation(query);
    };

    // Determine if we're on a pod page
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

SearchBar.propTypes = {
    onSearchResults: PropTypes.func.isRequired
};

export default SearchBar;