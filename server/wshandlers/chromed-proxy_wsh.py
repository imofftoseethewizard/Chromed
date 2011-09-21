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

# The chromed proxy provides the persistent intermediary between the chrome browser and its
# clients.  As a long running process, it keeps open websockets between the chrome browser and
# itself.  It makes these sockets available to other processes on a local port.

import traceback

import asyncore, socket
from threading import Event, Lock, Thread

from mod_pywebsocket.msgutil import ConnectionTerminatedException

import json

import logging, logging.handlers

log = logging.getLogger('chromedproxy')
log.setLevel(logging.DEBUG)


#================================================================================================#
#  
# HOST, PORT, and BACKLOG are basic parameters for the underlying socket.
#  

HOST = 'localhost'
PORT = 41014
BACKLOG = 5


#================================================================================================#
#  
#   mod_pywebsocket Support
#  
#   mod_pywebsocket requires that handler modules implement a couple callables.
#  
#   web_socket_do_extra_handshake seems to be a relic of a prior version, present still for
#   backwards compatibility, I guess.
#  
#   web_socket_transfer_data is called when an incoming socket request has just been open.  The
#   socket is ready to send and receive data.  The socket will be closed once the function
#   returns.
#
#================================================================================================#


#------------------------------------------------------------------------------------------------#
#
#   This function does not appear to be called by the latest protocol version, hybi06, though it
#   appears in earlier implementations: hixie75, and hybi00; and in any case, there is no
#   additional protocol negotiation required.
#   

def web_socket_do_extra_handshake(request):
    pass


#------------------------------------------------------------------------------------------------#
#
#    A request from the chrome browser to the chromed proxy websocket handler induces the creation
#    of a thread to handle it.  That thread enters the following function:
#

def web_socket_transfer_data(request):

    # As long as the thread does not return from this function, the associated communication with
    # the requesting web page will be held open.  Therefore it is necessary for the relay server
    # to hold the thread captive until either the channel appears to have been closed by the
    # webpage, or the socket server is shutting down.  In the former case the stream will set the
    # server_terminated attribute on the request object.  In the latter, as of this writing, there
    # is no facility for graceful shutdown of the websocket server, and so this case is not
    # handled here, and is left to the OS/language to properly clean up.

    ChromedProxy().capture_thread(request)

    # capture_thread only returns after the websocket has been closed by the other side, possibly
    # never.


#------------------------------------------------------------------------------------------------#
#
#    This is a small class to support the ChromedProxy.  It provides a thread to run the asyncore
#    loop for dispatching the socket connection to chromed clients.
#

class AsynchronousLoopThread(Thread):

    def __init__(self, map, *args, **kwargs):
        super(AsynchronousLoopThread, self).__init__(*args, **kwargs)
        self.map = map
        log.debug('asyncore loop thread initialized')

    def run(self):
        log.debug('asyncore loop starting...')
        asyncore.loop(map=self.map)
        log.critical('asyncore loop exited.')


#------------------------------------------------------------------------------------------------#
#
#    This is another small class to support the ChromedProxy.  It provides access to the socket
#    connections to chromed clients.  It has no significant logic of its own, deferring to the
#    handle_command_request method of the ChromedProxy.
#

class CommandRequestConnection(asyncore.dispatcher_with_send, object):
    
    BLOCKSIZE = 8192
    
    def __init__(self, proxy, *args, **kwargs):
        self.proxy = proxy
        super(CommandRequestConnection, self).__init__(*args, **kwargs)
        log.debug('command request connection initialized')

        
    def handle_read(self):
        log.debug('receiving command request...')

        data = self.recv(CommandRequestConnection.BLOCKSIZE)
        log.debug('...data received, deferring to proxy...')
        if len(data) > 0:
            log.info('request: %s' % data)

        self.proxy.handle_command_request(self, data)
        log.debug('command request finished.')
        

class Singleton(type):

    _instance = None

    def __call__(cls, *args, **kwargs):
        if cls._instance is None:
            cls._instance = super(Singleton, cls).__call__(*args, **kwargs)

        return cls._instance


class ChromedProxy(asyncore.dispatcher, object):

    # There is only one relay server object, implemented as a singleton.  This hides the global
    # variable behind the class framework and ensures that access cannot happen without
    # initialization.
    
    __metaclass__ = Singleton


    def __init__(self):
        # Start an asyncore handling loop with a map specifically for this class. It needs to be
        # in a new thread, since it loops forever.  Passing the same map to the dispatcher parent
        # class ensures that the relay server and the asynchronous handling loop share the same
        # space of open sockets.

        log.debug('initializing')

        ChromedProxy.map = map = {}
        thread = AsynchronousLoopThread(map=map)
        super(ChromedProxy, self).__init__(map=map)

        #REVIEW
        # new_channels is a list of websocket request objects that have yet to be

        self.new_channels = []

        # release events is a dictionary keyed by websocket request objects.  The values are the
        # events which when signaled will release the captured thread associated with the
        # websocket request.
        
        self.release_events = {}

        # channels is a dictionary keyed by name with websocket requests as values.

        self.channels = {}

        # modification of new_channels, channels, and release_events need to be protected from
        # race conditions. A thread must acquire the jailer to be able to add or remove
        # captives. See capture_thread below.

        self.jailer = Lock()

        log.debug('creating socket...')

        self.create_socket(socket.AF_INET, socket.SOCK_STREAM)
        self.set_reuse_addr()
        self.bind((HOST, PORT))
        self.listen(BACKLOG)

        log.debug('...socket created on %s:%d' % (HOST, PORT))

        thread.start()

        log.debug('initialized.')


    def capture_thread(self, channel):

        log.info('capturing channel: %s' % str(channel.connection.remote_addr))
        
        # When a chrome browser requests a websocket from the server, that request eventually
        # arrives here (as the channel parameter). The thread of execution must be captured to
        # prevent the socket from closing. This function captures the thread by having it wait on
        # an event.  Should that event occur, it then removes references to the channel and
        # returns, allowing the thread and socket to be reclaimed.
        
        event = Event()
        
        with self.jailer:
            self.new_channels.append(channel)
            self.release_events[channel] = event

        # Capture the thread to keep the websocket open.

        log.debug('capturing channel: at wait')

        event.wait()

        log.debug('capturing channel: %s: event set, terminating'
                  % str(channel.connection.remote_addr))

        # If the thread reaches this point, then the websocket in the channel has terminated.


    def verify_new_channel(self, channel):
        
        log.debug('verifying channel: %s' % str(channel.connection.remote_addr))

        name = json.loads(self.request_name(channel.ws_stream))

        log.debug('verifying channel: name: %s' % name)

        if name is None:
            # That there was an error, or that the websocket has already closed.  There is no need
            # to do anything, as allowing the thread to return will release the socket, etc.

            log.info('verifying channel: %s: name is None, signaling termination.'
                     % str(channel.connection.remote_addr))

            self.release_events[channel].set()
            self.remove_channel(channel)

        else:
            with self.jailer:
                self.channels[name] = channel


    def remove_channel(self, channel):
        # After a channel has been terminated, this function removes mention of it from the
        # ChromedProxy's data structures.

        log.debug('removing channel: %s' % str(channel.connection.remote_addr))

        with self.jailer:
            del self.release_events[channel]
            for name, r in self.channels.items():
                if r == channel:
                    del self.channels[name]


    def request_name(self, stream):
        # This function is called to request the name of the listener at the other end of the
        # websocket.
        
        log.debug('requesting channel name...')

        try:
            stream.send_message("channel.name")
            log.debug('...request sent, receiving...')

            name = stream.receive_message()
            log.debug('...received')

        except ConnectionTerminatedException, e:
            log.debug('...connection terminated.')
            return None

        except:
            log.warning(traceback.format_exc())
            pass

        log.debug('name: %s' % name)

        return name


    def handle_accept(self):
        # The chromed client will connect to the socket established in __init__ of the
        # ChromedProxy; those connects are accepted here. A CommandRequestConnection object
        # manages the result of accept, and refers back to the server for all significant logic --
        # see handle_command_request, below.

        pair = self.accept()
        if pair is None:
            log.warning('accept failed')
            pass
        else:
            sock, addr = pair
            log.info('accepting connection from %s' % repr(addr))
            CommandRequestConnection(self, sock, map=ChromedProxy.map)


    def handle_command_request(self, conx, data):
        # In response to a message received from a chromed client, assumed for now to be a request
        # for quotes, a CommandRequestConnection object, here conx, will call this function to
        # forward the request to the appropriate channel.

        # zero length data implies hangup.
        if len(data) == 0:
            log.debug('chromed client connection shutdown by peer')
            conx.close()
            return

        # Check to see if any channels are new, and verify that they are now live.
        with self.jailer:
            new_channels = self.new_channels
            self.new_channels = []

        for channel in new_channels:
            self.verify_new_channel(channel)

        # Before handling the request, first check to see if any channels have shutdown.  If so,
        # remove them from the server's records, and signal for the captured threads to be
        # released.

        log.debug('received command request for %s' % data)

        for channel, event in self.release_events.items():
            if channel.server_terminated:
                log.debug('channel %s: server terminated' % str(channel.connection.remote_addr))
                self.remove_channel(channel)
                event.set()

        # If data starts with a '@' it is for a named channel; otherwise it's for the root.
        # Name-prefixed commands have the form '@<name>:<data>'.

        name, _, data = data[1:].partition(':') if data[0] == '@' else ('root', None, data)
        
        reply = None
        log.debug('channels: %s', self.channels.keys())
        if name in self.channels:
            channel = self.channels[name]

            try:
                channel.ws_stream.send_message(data)
                log.debug('request sent, receiving...')
                reply = channel.ws_stream.receive_message()

            except ConnectionTerminatedException:
                log.debug('...connection terminated.')
                self.release_events[channel].set()
                self.remove_channel(channel);

            except:
                log.critical(traceback.format_exc())

            log.debug('received, relaying reply...')

        try:
            log.info('reply: %s' % (reply or '@None'))
            conx.sendall(reply or '@None')
            log.debug('reply sent')

        except:
            log.critical(traceback.format_exc())




# Local Variables:
# mode: python
# c-basic-offset: 2
# indent-tabs-mode: nil
# fill-column: 98
# End:
