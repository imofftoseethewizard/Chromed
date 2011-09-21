#-------------------------------------------------------------------------------------------------
#
#  This file is part of Chromed.
#
#  Chromed is free software: you can redistribute it and/or modify it under the terms of the GNU
#  General Public License as published by the Free Software Foundation, either version 3 of the
#  License, or (at your option) any later version.
#
#  Chromed is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even
#  the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU General
#  Public License for more details.
#
#  You should have received a copy of the GNU General Public License along with Chromed.  If not,
#  see <http://www.gnu.org/licenses/>.
#
#  Copyright (c) 2011 Pat M. Lasswell
#
#-------------------------------------------------------------------------------------------------

import socket

HOST = 'localhost'
PORT = 41014
BLOCKSIZE = 8192

def chrome(command, channel='root'):
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.connect((HOST, PORT))
    sock.setblocking(True)
    sock.send(''.join(['@', channel, ':', command]))
    data = sock.recv(BLOCKSIZE)
    sock.shutdown(socket.SHUT_RDWR)
    sock.close()
    return data
