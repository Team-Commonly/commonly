import React, { useState, useCallback, useEffect } from 'react';
import axios from 'axios';
import { debounce } from 'lodash';
import { Button } from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import './SearchBar.css';

const SearchBar = ({ onSearchResults }) => {
    const [query, setQuery] = useState('');

    const performSearch = async (searchQuery) => {
        try {
            if (!searchQuery.trim()) {
                fetchAllPosts();
                return;
            }

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
            fetchAllPosts();
        }
    };

    const fetchAllPosts = async () => {
        try {
            const response = await axios.get('/api/posts', {
                headers: { Authorization: `Bearer ${localStorage.getItem('token')}` }
            });
            onSearchResults(response.data);
        } catch (err) {
            console.error('Failed to fetch posts:', err);
            onSearchResults([]);
        }
    };

    useEffect(() => {
        fetchAllPosts();
    }, []);

    const debouncedSearch = useCallback(
        debounce((searchQuery) => {
            performSearch(searchQuery);
        }, 500),
        []
    );

    const handleSearch = (e) => {
        const value = e.target.value;
        setQuery(value);
        debouncedSearch(value);
    };

    return (
        <div className="search-bar">
            <div className="search-inputs">
                <input
                    type="text"
                    placeholder="Search posts by content or #tags..."
                    value={query}
                    onChange={handleSearch}
                    className="search-input"
                />
                <Button
                    variant="contained"
                    color="primary"
                    onClick={() => performSearch(query)}
                    className="search-button"
                    startIcon={<SearchIcon />}
                >
                    Search
                </Button>
            </div>
        </div>
    );
};

export default SearchBar;