import axios from 'axios';

// Client code must not be mistaken for routes.
export const fetchUsers = () => axios.get('/api/users', { params: { page: 1 } });
