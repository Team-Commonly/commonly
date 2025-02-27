import React, { useEffect, useState } from 'react';
import axios from 'axios';
import { useParams } from 'react-router-dom';

const Thread = () => {
    const { id } = useParams();
    const [post, setPost] = useState(null);
    const [error, setError] = useState('');

    useEffect(() => {
        const fetchPost = async () => {
            try {
                const res = await axios.get(`/api/posts/${id}`);
                setPost(res.data);
            } catch (err) {
                setError('Failed to fetch post. Please try again later.');
            }
        };
        fetchPost();
    }, [id]);

    if (error) return <p style={{ color: 'red' }}>{error}</p>;
    if (!post) return <p>Loading...</p>;

    return (
        <div>
            <h3>{post.userId.username}</h3>
            <p>{post.content}</p>
            {post.comments.map((comment) => (
                <div key={comment._id}>
                    <p>{comment.text}</p>
                </div>
            ))}
        </div>
    );
};

export default Thread;
